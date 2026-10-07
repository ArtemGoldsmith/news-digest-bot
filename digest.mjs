// news-digest-bot — daily news digest: RSS -> Gemini -> Telegram.
// Runs on GitHub Actions (see .github/workflows/digest.yml), zero npm dependencies.
//
// Persona, feeds and the optional local section live in digest.config.mjs
// (gitignored) or, as a fallback, digest.config.example.mjs — see lib/config.mjs.

import { loadConfig } from "./lib/config.mjs";
import { capped, fetchFeed, freshDeduped, localAreaFilter } from "./lib/feed.mjs";
import { localExclusionRule, substituteLinks } from "./lib/format.mjs";
import { GEMINI_LOCAL_BUDGET_MS, callGemini } from "./lib/gemini.mjs";
import { digestPrompt, localPrompt } from "./lib/prompts.mjs";
import { checkSeen, itemKeys, markSeen, selectLocal } from "./lib/seen.mjs";
import { sendDigest } from "./lib/telegram.mjs";

const MAX_ITEMS_PER_FEED = 25;
const MAX_ITEMS_TOTAL = 140;
const MAX_AGE_HOURS = 26;
const LOCAL_MAX_AGE_HOURS = 72;
const LOCAL_MAX_ITEMS = 40;
const TELEGRAM_CHUNK = 4000; // hard API limit is 4096
const LOCAL_NONE = "NONE";

const { GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
// DRY_RUN=1 runs the whole pipeline against live feeds but prints the digest
// instead of sending it, and performs no side effects at all.
const DRY_RUN = process.env.DRY_RUN === "1";

const required = DRY_RUN
  ? { GEMINI_API_KEY }
  : { GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID };
for (const [name, val] of Object.entries(required)) {
  if (!val) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

const { path: configPath, config } = await loadConfig();
const { persona, output, local } = config;
console.log(`config: ${configPath}`);

async function collect(feeds) {
  const perFeed = await Promise.all(feeds.map((f) => fetchFeed(f.url, MAX_ITEMS_PER_FEED)));
  return perFeed.flatMap((items, n) =>
    items.map((i) => ({ ...i, official: feeds[n].official === true })));
}

// Set by whichever section lost its model call: it separates "Gemini is down"
// (a real failure, red in Actions) from "the feeds gave us nothing" (quiet).
let geminiFailed = false;

const askGemini = (prompt, opts) => callGemini(prompt, { apiKey: GEMINI_API_KEY, ...opts });

const REPLY_KEYBOARD = {
  keyboard: [[{ text: "📰 Digest now" }]],
  resize_keyboard: true,
  is_persistent: true,
};

async function tgSend(text, parseMode) {
  // Guarded here rather than at the call sites: the "all feeds failed" notice
  // calls tgSend directly, so guarding only sendDigest would still hit Telegram.
  if (DRY_RUN) {
    console.log(`\n--- DRY_RUN would send (${parseMode ?? "plain"}) ---\n${text}\n`);
    return;
  }
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    reply_markup: REPLY_KEYBOARD,
  };
  if (parseMode) body.parse_mode = parseMode;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
}

const seenCfg = { ingestUrl: process.env.INGEST_URL, secret: process.env.INGEST_SECRET };

// Local first: its own window, its own model call, and its items must be
// filtered against what was already sent before the cap is applied.
// No `local` config means no local feeds are fetched and the section is skipped.
const localCandidates = local
  ? freshDeduped(await collect(local.feeds), { maxAgeHours: LOCAL_MAX_AGE_HOURS, staleFallback: false })
  : [];
// Before the cap: a high-volume regional feed that mostly carries national
// copy would otherwise take most of the slots while real local stories fall
// off the end.
const localRelevant = local ? localCandidates.filter(localAreaFilter(local.places)) : [];
const seen = await checkSeen(localRelevant.flatMap(itemKeys), seenCfg);
const localNews = selectLocal(localRelevant, seen, LOCAL_MAX_ITEMS);

const news = capped(
  freshDeduped(await collect(config.feeds), { maxAgeHours: MAX_AGE_HOURS, staleFallback: true }),
  MAX_ITEMS_TOTAL,
);
console.log(`collected ${news.length} global, ${localNews.length} local items (${localCandidates.length} local candidates, ${localCandidates.length - localRelevant.length} dropped as non-local)`);

// Google News puts only an <a> blob in <description>, which strips down to the
// headline again — appending that would just duplicate the title and spend
// tokens. Only include a description that actually adds text.
const usefulDescription = (item) => {
  const d = item.description ?? "";
  if (d.length < 40) return "";
  const head = item.title.slice(0, 30).toLowerCase();
  return d.toLowerCase().startsWith(head) ? "" : d;
};

const localNewsList = localNews
  .map((i, n) => {
    const desc = usefulDescription(i);
    return `${n + 1}. [${i.source || "?"}] ${i.title}${desc ? ` — ${desc}` : ""} | ${i.pubDate.toISOString()}`;
  })
  .join("\n");

const localPromptText = local
  ? localPrompt({ local, output, newsList: localNewsList, noneToken: LOCAL_NONE })
  : "";

async function buildLocalSection() {
  if (!local) {
    console.log("local: not configured, section skipped");
    return null;
  }
  if (localNews.length === 0) {
    console.log("local: pool empty, section skipped");
    return null;
  }
  let raw;
  try {
    // A capped budget, not the default one: this call runs first, and a long
    // ladder here would leave the global digest nothing to spend.
    raw = await askGemini(localPromptText, { budgetMs: GEMINI_LOCAL_BUDGET_MS });
  } catch (e) {
    geminiFailed = true;
    console.error(`local section failed (${e.message}) — skipping it`);
    return null;
  }
  if (raw.trim() === LOCAL_NONE || raw.trim() === "") {
    console.log("local: model found nothing relevant");
    return null;
  }
  const section = substituteLinks(raw, localNews);
  // A section with no resolvable citation is a header and nothing else. Treat
  // it as absent: otherwise it would still suppress the city in the global
  // digest and ship an empty block.
  if (section.citedIndices.length === 0) {
    console.log("local: model produced no valid citations, section dropped");
    return null;
  }
  return section;
}

const localSection = await buildLocalSection();

const newsList = news
  .map((i, n) => `${n + 1}. [${i.source || "?"}] ${i.title} | ${i.pubDate.toISOString()}`)
  .join("\n");

const today = new Date().toLocaleDateString(output.locale, {
  day: "numeric", month: "long", year: "numeric", timeZone: output.timeZone,
});

const prompt = digestPrompt({
  persona,
  output,
  today,
  newsList,
  exclusionRule: localExclusionRule(localSection, local?.name),
});

async function buildGlobalDigest() {
  if (news.length === 0) return "";
  try {
    return substituteLinks(await askGemini(prompt), news).text;
  } catch (e) {
    // Mirrors the local section: letting this throw out of the top-level await
    // would kill the job with exit 1 and send nothing at all.
    geminiFailed = true;
    console.error(`global digest failed (${e.message}) — skipping it`);
    return "";
  }
}

const globalDigest = await buildGlobalDigest();
const digest = [globalDigest, localSection?.text].filter(Boolean).join("\n\n");

if (!digest) {
  // A dead model is a failure worth seeing red in Actions — and worth NOT
  // announcing in the chat, where it would just be noise.
  if (geminiFailed) {
    console.error("nothing to send: every Gemini call failed");
    process.exit(1);
  }
  await tgSend("📭 No news could be fetched today (every feed failed).");
  process.exit(0);
}

await sendDigest(digest, { send: tgSend, visibleLimit: TELEGRAM_CHUNK });
console.log("digest sent");

// Marked only after a successful send: suppressing a story Telegram never
// received is worse than repeating one.
if (localSection && !DRY_RUN) {
  await markSeen(localSection.citedIndices.flatMap((i) => itemKeys(localNews[i])), seenCfg);
}

// Let the interactive bot (Cloudflare Worker) know the latest digest content
if (!DRY_RUN && process.env.INGEST_URL && process.env.INGEST_SECRET) {
  try {
    const res = await fetch(process.env.INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ingest-Secret": process.env.INGEST_SECRET },
      body: JSON.stringify({ text: digest }),
    });
    console.log(`ingest: HTTP ${res.status}`);
  } catch (e) {
    console.error(`ingest failed (non-fatal): ${e.message}`);
  }
}
