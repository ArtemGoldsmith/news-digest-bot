// news-digest-bot interactive bot: Telegram webhook -> Gemini (with Google
// Search grounding) -> reply. Also fires the daily digest (cron -> GitHub
// Actions) and stores the latest digest in KV so the user can ask about it.
//
// Configuration (never committed): ALLOWED_CHAT_ID and GH_REPO are secrets,
// see worker/wrangler.example.toml. BOT_LANGUAGE (var, default English) sets
// the language of the bot's answers.

// 2.5-flash first: Google Search grounding is confirmed working on it in the
// free tier (1500 req/day), while Gemini-3 models 429 on grounded requests.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-3-flash-preview"];
const HISTORY_LIMIT = 12;
const HISTORY_TTL = 86400; // seconds; a day-old conversation is stale anyway

const SEEN_TTL = 7 * 86400; // seconds
const SEEN_KEY_RE = /^[tu]:[0-9a-f]{16}$/;
const SEEN_MAX_KEYS = 200;

// Must match the button label sent by digest.mjs.
const DIGEST_BUTTON = "📰 Digest now";

const REPLY_KEYBOARD = {
  keyboard: [[{ text: DIGEST_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

export default {
  async scheduled(event, env) {
    await triggerDigestWorkflow(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      const msg = update.message;
      if (msg?.chat && String(msg.chat.id) === env.ALLOWED_CHAT_ID && msg.text) {
        // Ack Telegram immediately; a slow grounded Gemini call would otherwise
        // hit the webhook timeout and cause duplicate deliveries.
        ctx.waitUntil(handleMessage(msg.text.trim(), msg.reply_to_message?.text, env));
      }
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      if (request.headers.get("X-Ingest-Secret") !== env.INGEST_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const { text } = await request.json();
      await env.KV.put("digest:last", JSON.stringify({ text, at: new Date().toISOString() }));
      return new Response("ok");
    }

    if (request.method === "POST" && (url.pathname === "/seen/check" || url.pathname === "/seen/mark")) {
      return handleSeen(request, env, url.pathname.endsWith("/mark"));
    }

    return new Response("news-digest-bot", { status: 200 });
  },
};

// Cross-run dedup state for the digest's local section. One KV entry per key
// with a TTL: a single JSON blob would lose updates when two writers race, and
// would need its own pruning pass.
async function handleSeen(request, env, isMark) {
  if (request.headers.get("X-Ingest-Secret") !== env.INGEST_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const keys = body?.keys;
  const valid =
    Array.isArray(keys) &&
    keys.length <= SEEN_MAX_KEYS &&
    keys.every((k) => typeof k === "string" && SEEN_KEY_RE.test(k));
  if (!valid) return new Response("bad keys", { status: 400 });

  if (isMark) {
    await Promise.all(keys.map((k) => env.KV.put(`seen:${k}`, "1", { expirationTtl: SEEN_TTL })));
    return Response.json({ ok: true, stored: keys.length });
  }
  const found = await Promise.all(keys.map(async (k) => ((await env.KV.get(`seen:${k}`)) ? k : null)));
  return Response.json({ seen: found.filter(Boolean) });
}

async function handleMessage(text, quotedText, env) {
  try {
    if (text === DIGEST_BUTTON || text === "/digest") {
      await triggerDigestWorkflow(env);
      await tgSend(env, "⏳ Building the digest — it will arrive in ~2 minutes.");
      return;
    }
    if (text === "/start") {
      await tgSend(
        env,
        "Hi! I send a news digest once a day. The button below builds one right now. Anything else you type is a question: I will answer, search the web, or go deeper into a story from the digest.",
      );
      return;
    }
    await tgSendAction(env);
    await answerQuestion(text, quotedText, env);
  } catch (e) {
    console.error("handleMessage failed:", e.message);
    await tgSend(env, `⚠️ Could not answer: ${e.message}`).catch(() => {});
  }
}

async function answerQuestion(question, quotedText, env) {
  const [digestRaw, historyRaw] = await Promise.all([
    env.KV.get("digest:last"),
    env.KV.get("history:main"),
  ]);
  const digest = digestRaw ? JSON.parse(digestRaw) : null;
  const history = historyRaw ? JSON.parse(historyRaw) : [];

  const language = env.BOT_LANGUAGE || "English";
  const systemInstruction = `You are a news assistant in Telegram. Answer in ${language}, briefly and to the point.
MAIN RULE: answer exactly the question asked, directly and substantively. If asked for an opinion, an assessment or "can this be trusted", give a reasoned assessment with a clear conclusion, based on facts and search. Do NOT retell a story from the digest instead of answering — the user has already read it; a retelling is only appropriate when explicitly requested.
You have a Google Search tool — use it for questions about news and facts, and answer from fresh data.
${digest ? `The latest digest that was sent (at ${digest.at}) — if the question is about "a story from the digest", it refers to this:\n${digest.text}` : "No digest has been sent today yet."}
Formatting: ONLY Telegram HTML tags: <b>, <i>, <a href="URL">. No Markdown. Escape < > & in plain text as &lt; &gt; &amp;.`;

  const userText = quotedText
    ? `The user is replying to this bot message:\n"""\n${quotedText}\n"""\n\nQuestion: ${question}`
    : question;

  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: userText }] },
  ];

  const { text: answer, sources } = await callGemini(env, systemInstruction, contents);

  let reply = answer;
  if (sources.length) {
    const links = sources
      .slice(0, 3)
      .map((s) => `<a href="${escapeHtml(s.uri)}">${escapeHtml(s.title || "source")}</a>`)
      .join(", ");
    reply += `\n\n<i>Sources:</i> ${links}`;
  }
  await tgSend(env, reply, "HTML");

  const newHistory = [...history, { role: "user", text: question }, { role: "model", text: answer }]
    .slice(-HISTORY_LIMIT);
  await env.KV.put("history:main", JSON.stringify(newHistory), { expirationTtl: HISTORY_TTL });
}

async function callGemini(env, systemInstruction, contents) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents,
            tools: [{ google_search: {} }],
          }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";
        if (text.trim()) {
          const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
            .map((c) => c.web)
            .filter(Boolean);
          return { text: text.trim(), sources };
        }
        lastError = `empty response from ${model}`;
      } else {
        lastError = `${model} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        console.error(lastError);
        if (res.status !== 429 && res.status !== 503) break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(lastError);
}

async function triggerDigestWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "news-digest-bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (res.status !== 204) {
    throw new Error(`workflow dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function tgSend(env, text, parseMode) {
  const send = async (t, mode) => {
    const body = {
      chat_id: env.ALLOWED_CHAT_ID,
      text: t,
      disable_web_page_preview: true,
      reply_markup: REPLY_KEYBOARD,
    };
    if (mode) body.parse_mode = mode;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  // 4096 is the visible-text limit; answers that long are rare — truncate rather than chunk
  const capped = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
  let result = await send(capped, parseMode);
  if (!result.ok && parseMode) {
    result = await send(capped.replace(/<[^>]+>/g, ""), undefined);
  }
  if (!result.ok) throw new Error(`Telegram: ${result.description}`);
}

async function tgSendAction(env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.ALLOWED_CHAT_ID, action: "typing" }),
  }).catch(() => {});
}
