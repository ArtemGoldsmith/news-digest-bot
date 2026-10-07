import test from "node:test";
import assert from "node:assert/strict";
import { checkSeen, itemKeys, markSeen, normalizeTitle, selectLocal } from "../lib/seen.mjs";

const CFG = { ingestUrl: "https://bot.example.com/ingest", secret: "s3cr3t" };

test("normalizeTitle lowercases, strips punctuation, trims and caps at 80", () => {
  assert.equal(normalizeTitle("  Crème brûlée, à la française!!  "), "crème brûlée à la française");
  assert.equal(normalizeTitle("x".repeat(200)).length, 80);
});

test("itemKeys yields a title key and a link key", () => {
  const keys = itemKeys({ title: "Požár", link: "https://a/1" });
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^t:[0-9a-f]{16}$/);
  assert.match(keys[1], /^u:[0-9a-f]{16}$/);
});

test("itemKeys omits the link key when there is no link", () => {
  assert.equal(itemKeys({ title: "Požár", link: "" }).length, 1);
});

test("itemKeys is stable for titles differing only in case and punctuation", () => {
  assert.equal(itemKeys({ title: "Crème brûlée à la française", link: "" })[0],
               itemKeys({ title: "CRÈME, brûlée à la française!", link: "" })[0]);
});

test("checkSeen returns the seen set and targets /seen/check on the origin", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    captured = { url: String(url), opts };
    return Response.json({ seen: ["t:aaaaaaaaaaaaaaaa"] });
  });
  const seen = await checkSeen(["t:aaaaaaaaaaaaaaaa", "u:bbbbbbbbbbbbbbbb"], CFG);
  assert.deepEqual([...seen], ["t:aaaaaaaaaaaaaaaa"]);
  assert.equal(captured.url, "https://bot.example.com/seen/check");
  assert.equal(captured.opts.headers["X-Ingest-Secret"], "s3cr3t");
});

test("checkSeen swallows a non-2xx response and reports nothing seen", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
  assert.equal((await checkSeen(["t:aaaaaaaaaaaaaaaa"], CFG)).size, 0);
});

test("checkSeen swallows a network error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
  assert.equal((await checkSeen(["t:aaaaaaaaaaaaaaaa"], CFG)).size, 0);
});

test("checkSeen swallows a malformed payload", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ nope: true }));
  assert.equal((await checkSeen(["t:aaaaaaaaaaaaaaaa"], CFG)).size, 0);
});

test("checkSeen rejects a seen array containing non-strings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ seen: [42] }));
  assert.equal((await checkSeen(["t:aaaaaaaaaaaaaaaa"], CFG)).size, 0);
});

test("checkSeen makes no request when unconfigured or given no keys", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ seen: [] }));
  assert.equal((await checkSeen([], CFG)).size, 0);
  assert.equal((await checkSeen(["t:aaaaaaaaaaaaaaaa"], { ingestUrl: "", secret: "" })).size, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("checkSeen chunks requests above the 200-key limit", async (t) => {
  const sizes = [];
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    sizes.push(JSON.parse(opts.body).keys.length);
    return Response.json({ seen: [] });
  });
  await checkSeen(Array.from({ length: 450 }, (_, i) => `t:${String(i).padStart(16, "0")}`), CFG);
  assert.deepEqual(sizes, [200, 200, 50]);
});

test("markSeen posts to /seen/mark", async (t) => {
  let path;
  t.mock.method(globalThis, "fetch", async (url) => { path = new URL(url).pathname; return Response.json({ ok: true }); });
  await markSeen(["t:aaaaaaaaaaaaaaaa"], CFG);
  assert.equal(path, "/seen/mark");
});

test("markSeen never throws on a network error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("down"); });
  await assert.doesNotReject(markSeen(["t:aaaaaaaaaaaaaaaa"], CFG));
});

test("markSeen treats a response without ok:true as a failure", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (m) => errors.push(m));
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.doesNotReject(markSeen(["t:aaaaaaaaaaaaaaaa"], CFG));
  assert.match(errors.join(" "), /malformed response/);
});

test("duplicate keys are sent once", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    sent = JSON.parse(opts.body).keys;
    return Response.json({ ok: true });
  });
  await markSeen(["t:aaaaaaaaaaaaaaaa", "t:aaaaaaaaaaaaaaaa", "u:bbbbbbbbbbbbbbbb"], CFG);
  assert.deepEqual(sent, ["t:aaaaaaaaaaaaaaaa", "u:bbbbbbbbbbbbbbbb"]);
});

test("selectLocal filters seen items BEFORE capping, so an unseen item cannot be starved", () => {
  const item = (title) => ({ title, link: `https://a/${title}` });
  const candidates = [...Array.from({ length: 40 }, (_, i) => item(`seen${i}`)), item("unseen")];
  const seen = new Set(candidates.slice(0, 40).flatMap(itemKeys));
  const kept = selectLocal(candidates, seen, 40);
  assert.deepEqual(kept.map((i) => i.title), ["unseen"]);
});

test("selectLocal matches on either the title key or the link key", () => {
  const a = { title: "Same headline", link: "https://a/1" };
  const sameTitleOtherLink = { title: "Same headline", link: "https://b/9" };
  const sameLinkOtherTitle = { title: "Rewritten", link: "https://a/1" };
  const seen = new Set(itemKeys(a));
  assert.equal(selectLocal([sameTitleOtherLink], seen, 10).length, 0);
  assert.equal(selectLocal([sameLinkOtherTitle], seen, 10).length, 0);
  assert.equal(selectLocal([{ title: "Unrelated", link: "https://c/1" }], seen, 10).length, 1);
});
