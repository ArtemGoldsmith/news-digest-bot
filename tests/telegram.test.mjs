import test from "node:test";
import assert from "node:assert/strict";
import { sendDigest } from "../lib/telegram.mjs";

// A stub Telegram that rejects any HTML message heavier than `entityBudget`,
// the way the real API answers ENTITIES_TOO_LONG.
function fakeTelegram(entityBudget) {
  const sent = [];
  const send = async (text, parseMode) => {
    if (parseMode === "HTML" && text.length > entityBudget) {
      throw new Error("Telegram: Bad Request: ENTITIES_TOO_LONG");
    }
    sent.push({ text, parseMode });
  };
  return { sent, send };
}

const link = (n) => `article ${n} <a href="https://news.google.com/${"u".repeat(450)}">provider</a>`;
const digest = (n) => Array.from({ length: n }, (_, i) => link(i + 1)).join("\n");
const opts = (send, extra = {}) => ({ send, visibleLimit: 4000, sleepImpl: async () => {}, ...extra });

test("a digest inside every budget goes out as one HTML message", async () => {
  const { sent, send } = fakeTelegram(100_000);
  await sendDigest(digest(5), opts(send));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parseMode, "HTML");
});

test("a link-heavy digest is pre-split by the raw budget", async () => {
  const { sent, send } = fakeTelegram(100_000);
  await sendDigest(digest(40), opts(send));
  assert.ok(sent.length > 1, "40 long links must not be sent as one message");
  assert.ok(sent.every((m) => m.parseMode === "HTML"), "links must survive: no plain-text degradation");
});

test("when the raw budget is still too generous, it re-splits instead of stripping links", async () => {
  // The estimate is wrong by 8x here: Telegram accepts far less than we assumed.
  const { sent, send } = fakeTelegram(1_200);
  await sendDigest(digest(20), opts(send, { rawLimit: 8000 }));
  assert.ok(sent.every((m) => m.parseMode === "HTML"), "every message must keep its markup");
  assert.ok(sent.every((m) => m.text.length <= 1_200), "every message must fit the real budget");
  const delivered = sent.map((m) => m.text).join("\n");
  for (let n = 1; n <= 20; n++) {
    assert.ok(delivered.includes(`article ${n} `), `story ${n} was dropped`);
  }
});

test("invalid HTML still degrades to plain text rather than failing", async () => {
  const sent = [];
  const send = async (text, parseMode) => {
    if (parseMode === "HTML") throw new Error("Telegram: Bad Request: can't parse entities");
    sent.push({ text, parseMode });
  };
  await sendDigest("<b>malformed <i>HTML</b>", opts(send));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parseMode, undefined);
  assert.equal(sent[0].text, "malformed HTML");
});

test("a single unsplittable line that Telegram rejects falls back to plain text", async () => {
  // One line cannot be split without cutting inside an <a> tag, so halving the
  // budget can never help — the recursion has to bottom out, not spin.
  const { sent, send } = fakeTelegram(100);
  await sendDigest(link(1), opts(send));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parseMode, undefined);
  assert.ok(!sent[0].text.includes("<a"));
});
