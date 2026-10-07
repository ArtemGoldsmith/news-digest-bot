import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

const KEY_A = "t:aaaaaaaaaaaaaaaa";
const KEY_B = "u:bbbbbbbbbbbbbbbb";

function makeEnv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    INGEST_SECRET: "s3cr3t",
    puts,
    KV: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v, opts) => { store.set(k, v); puts.push({ k, opts }); },
    },
  };
}

const post = (path, body, secret = "s3cr3t") =>
  new Request(`https://bot.example.com${path}`, {
    method: "POST",
    headers: { "X-Ingest-Secret": secret, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let env;
test.beforeEach(() => { env = makeEnv({ [`seen:${KEY_A}`]: "1" }); });

test("check returns only the keys already stored", async () => {
  const res = await worker.fetch(post("/seen/check", { keys: [KEY_A, KEY_B] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { seen: [KEY_A] });
});

test("mark stores every key with a 7-day TTL", async () => {
  const res = await worker.fetch(post("/seen/mark", { keys: [KEY_B] }), env, {});
  assert.deepEqual(await res.json(), { ok: true, stored: 1 });
  assert.equal(env.puts[0].k, `seen:${KEY_B}`);
  assert.equal(env.puts[0].opts.expirationTtl, 604800);
});

test("a wrong secret is rejected on both endpoints", async () => {
  for (const path of ["/seen/check", "/seen/mark"]) {
    const res = await worker.fetch(post(path, { keys: [KEY_A] }, "wrong"), env, {});
    assert.equal(res.status, 403);
  }
});

test("malformed keys, oversized batches and bad JSON are rejected", async () => {
  const bad = [
    { keys: ["nope"] },
    { keys: [`t:${"z".repeat(16)}`] },
    { keys: [KEY_A, 42] },
    { keys: "not-an-array" },
    { nope: true },
    { keys: Array.from({ length: 201 }, () => KEY_A) },
  ];
  for (const body of bad) {
    assert.equal((await worker.fetch(post("/seen/check", body), env, {})).status, 400, JSON.stringify(body));
  }
  assert.equal((await worker.fetch(post("/seen/check", "{oops"), env, {})).status, 400);
});

test("an empty key list is accepted and stores nothing", async () => {
  const res = await worker.fetch(post("/seen/mark", { keys: [] }), env, {});
  assert.deepEqual(await res.json(), { ok: true, stored: 0 });
  assert.equal(env.puts.length, 0);
});

test("the catch-all still answers unknown paths", async () => {
  const res = await worker.fetch(new Request("https://bot.example.com/nope"), env, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "news-digest-bot");
});
