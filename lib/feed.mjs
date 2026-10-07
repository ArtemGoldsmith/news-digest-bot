// RSS ingest: fetch, parse, and build the item pools the digest selects from.

import { normalizeTitle } from "./seen.mjs";

export const stripHtml = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const block = m[1];
    const pick = (tag) => {
      const t = block.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s"));
      return t ? decodeEntities(t[1]) : "";
    };
    const rawTitle = pick("title");
    if (!rawTitle) continue;
    const source = pick("source");
    // Google News appends " - <Publisher>" to every title. Left in place, the
    // same story from Google News and from the publisher's own RSS normalizes
    // to two different dedup keys and shows up twice.
    const suffix = source ? ` - ${source}` : "";
    const title = suffix && rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
    items.push({
      title,
      link: pick("link"),
      source,
      description: stripHtml(pick("description")).slice(0, 300),
      pubDate: new Date(pick("pubDate") || 0),
    });
  }
  return items;
}

// The timeout is load-bearing, not defensive: the local pool is collected
// before the global one, and a feed that stalls without it would burn the
// job's 15-minute budget and stop the global digest from ever being sent.
const FEED_TIMEOUT_MS = 20_000;

export async function fetchFeed(url, maxItems) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "news-digest-bot/1.0" },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseRss(await res.text());
    console.log(`feed ok (${items.length} items): ${url}`);
    return items.slice(0, maxItems);
  } catch (e) {
    console.error(`feed FAILED (${e.message}): ${url}`);
    return [];
  }
}

// Window + in-run dedup, deliberately WITHOUT a cap: the caller filters
// already-sent items first, so capping here could let seen items starve an
// unseen one further down the list.
export function freshDeduped(items, { maxAgeHours, staleFallback, now = Date.now() }) {
  const cutoff = now - maxAgeHours * 3600_000;
  let fresh = items.filter((i) => i.pubDate.getTime() > cutoff);
  // Feeds without pubDate would otherwise yield nothing — better stale than
  // empty for the global digest. The local pool must NOT do this: on a quiet
  // week it would resurrect month-old city notices instead of hiding.
  if (fresh.length === 0 && staleFallback) fresh = items;
  const seen = new Set();
  const out = [];
  for (const item of [...fresh].sort((a, b) => b.pubDate - a.pubDate)) {
    const key = normalizeTitle(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export const capped = (items, maxItems) => items.slice(0, maxItems);

// The configured place list (city, nearby towns, districts that show up in
// headlines) matched against title, description and source — outlet names like
// "<City> Daily" are themselves a locality signal.
//
// This exists because a local pool is often dominated by one high-volume
// regional feed that mostly carries national copy. Sorting by recency then let
// nationwide stories take most of the slots and push genuinely local ones off
// the end.
//
// `places` is either a RegExp or an array of regex fragments (joined with |,
// case-insensitive, unicode). No places configured means no geographic filter.
export function placesPattern(places) {
  if (places instanceof RegExp) {
    // A /g regex is stateful under .test(); drop the flag rather than skip items.
    return new RegExp(places.source, places.flags.replace("g", ""));
  }
  if (Array.isArray(places) && places.length > 0) return new RegExp(places.join("|"), "iu");
  return null;
}

// Feeds marked `official: true` (e.g. the city hall's own RSS) bypass the check.
export function localAreaFilter(places) {
  const re = placesPattern(places);
  return (item) =>
    item.official === true ||
    re === null ||
    re.test(`${item.title} ${item.description ?? ""} ${item.source ?? ""}`);
}

export const mentionsLocalArea = (item, places) => localAreaFilter(places)(item);
