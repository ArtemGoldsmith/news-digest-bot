import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_BUDGET_MS,
  GEMINI_LOCAL_BUDGET_MS,
  GEMINI_MODELS,
  GEMINI_TIMEOUT_MS,
  callGemini,
} from "../lib/gemini.mjs";

const ok = (text) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});
const httpError = (status) => ({ ok: false, status, text: async () => `HTTP ${status}` });
const timeout = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

// Records every model the ladder actually reached, so a test can assert that a
// fallback was tried rather than only that the call eventually resolved.
function recorder(handlers) {
  const calls = [];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    bodies.push(JSON.parse(init.body));
    return handlers(model, calls.filter((m) => m === model).length);
  };
  return { calls, bodies, fetchImpl };
}

const MODELS = ["model-a", "model-b", "model-c"];
const opts = (fetchImpl) => ({
  apiKey: "k",
  models: MODELS,
  fetchImpl,
  sleepImpl: async () => {},
});

test("returns the first non-empty completion", async () => {
  const { calls, fetchImpl } = recorder(() => ok("  digest  "));
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.deepEqual(calls, ["model-a"]);
});

test("retries the same model on 503, then succeeds", async () => {
  const { calls, fetchImpl } = recorder((_m, n) => (n === 1 ? httpError(503) : ok("digest")));
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.deepEqual(calls, ["model-a", "model-a"]);
});

test("a network timeout is transient: it retries and falls through to the next model", async () => {
  // Regression: model-a 503s, then a request hangs past the timeout. The thrown
  // DOMException must not escape the ladder — otherwise model-b is never
  // reached and the whole job dies with exit 1.
  const { calls, fetchImpl } = recorder((model, n) => {
    if (model === "model-a") return n === 1 ? httpError(503) : timeout();
    return ok("digest");
  });
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.equal(calls.filter((m) => m === "model-a").length, 3);
  assert.ok(calls.includes("model-b"), "fallback model must be tried after a timeout");
});

test("a timeout on every model rejects with a plain Error, not a DOMException", async () => {
  const { fetchImpl } = recorder(timeout);
  await assert.rejects(
    () => callGemini("p", opts(fetchImpl)),
    (e) => e instanceof Error && !(e instanceof DOMException) && /All Gemini models failed/.test(e.message),
  );
});

test("a non-transient status skips the remaining attempts and tries the next model", async () => {
  const { calls, fetchImpl } = recorder((model) => (model === "model-a" ? httpError(400) : ok("digest")));
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.deepEqual(calls, ["model-a", "model-b"]);
});

test("an empty completion is retried and then falls through", async () => {
  const { calls, fetchImpl } = recorder((model) => (model === "model-a" ? ok("   ") : ok("digest")));
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.equal(calls.filter((m) => m === "model-a").length, 3);
  assert.equal(calls.at(-1), "model-b");
});

test("all models exhausted rejects with the last error", async () => {
  const { calls, fetchImpl } = recorder(() => httpError(503));
  await assert.rejects(() => callGemini("p", opts(fetchImpl)), /All Gemini models failed.*503/s);
  assert.equal(calls.length, MODELS.length * 3);
});

test("the retry ladder stops once the time budget is spent", async () => {
  // Local runs before global inside a 15-minute job: an unbounded ladder here
  // leaves the main digest no time at all.
  let clock = 0;
  const { calls, fetchImpl } = recorder(() => {
    clock += 90_000;
    return httpError(503);
  });
  await assert.rejects(() => callGemini("p", {
    ...opts(fetchImpl),
    budgetMs: 200_000,
    now: () => clock,
  }));
  assert.ok(calls.length < MODELS.length * 3, `budget must cut the ladder short, got ${calls.length} calls`);
});

// A ladder driven by a virtual clock: requests and backoffs consume time, which
// is the only way to reproduce what actually broke the digest — real elapsed
// time, not an instantly-thrown stub.
function timedLadder({ requestMs, budgetMs }) {
  let clock = 0;
  const armed = [];
  const { calls, bodies, fetchImpl } = recorder(() => {
    // A hanging request ends at whichever comes first: the model answering or
    // the abort the caller armed. Reading the armed delay rather than assuming
    // it is what keeps this faithful — the ladder clamps it to the model's share.
    clock += Math.min(requestMs, armed.at(-1));
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const run = async () => {
    const real = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      armed.push(ms);
      return real.call(AbortSignal, 60_000);
    };
    try {
      return await callGemini("p", {
        apiKey: "k",
        models: MODELS,
        fetchImpl,
        budgetMs,
        sleepImpl: async (ms) => { clock += ms; },
        now: () => clock,
      });
    } finally {
      AbortSignal.timeout = real;
    }
  };
  return { armed, calls, bodies, run };
}

test("a model that hangs on every attempt still leaves the fallbacks their turn", async () => {
  // Regression: when every request runs into the timeout, the first model must
  // not spend the whole budget on its retries and starve the fallbacks.
  const { armed, calls, run } = timedLadder({ requestMs: GEMINI_TIMEOUT_MS, budgetMs: GEMINI_BUDGET_MS });
  await assert.rejects(run);
  assert.deepEqual([...new Set(calls)], MODELS, "every model must get a turn before the budget runs out");
});

test("the per-model share is a whole number of milliseconds", async () => {
  // A budget that does not divide evenly: a fractional share reaches
  // AbortSignal.timeout as ERR_OUT_OF_RANGE, which the ladder counts as a failed
  // attempt and spends on nothing — no request is ever sent.
  const { armed, run } = timedLadder({ requestMs: GEMINI_TIMEOUT_MS, budgetMs: 200_000 });
  await assert.rejects(run);
  assert.ok(armed.length > 0, "the ladder must have armed at least one request");
  assert.ok(armed.every(Number.isInteger), `armed delays must be integers, got ${armed}`);
});

test("the capped local budget still reaches the fallbacks", async () => {
  const { calls, run } = timedLadder({ requestMs: GEMINI_TIMEOUT_MS, budgetMs: GEMINI_LOCAL_BUDGET_MS });
  await assert.rejects(run);
  assert.deepEqual([...new Set(calls)], MODELS, "a smaller budget must still be shared across the ladder");
});

test("the thinking retry does not cost the model an attempt", async () => {
  // Otherwise a rejection on the last attempt would move on without ever trying
  // the model as it wants to be called.
  const { calls, fetchImpl } = recorder((model, n) => {
    if (model !== "model-a") return ok("digest");
    if (n === 3) return { ok: false, status: 400, text: async () => "Thinking is not supported." };
    return httpError(503);
  });
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.equal(calls.filter((m) => m === "model-a").length, 4, "the config retry must be extra, not the last attempt");
});

test("a model that rejects the thinking switch is retried without it", async () => {
  // thinkingBudget is only backward-compatible on Gemini 3, and the alias moves.
  const { bodies, fetchImpl } = recorder((_m, n) =>
    (n === 1
      ? { ok: false, status: 400, text: async () => "Thinking budget is not supported for this model." }
      : ok("digest")));
  assert.equal(await callGemini("p", opts(fetchImpl)), "digest");
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(bodies[1].generationConfig, undefined, "the retry must drop the rejected switch");
});

test("the default ladder leads with the fast model and keeps the alias as the last resort", () => {
  // Ordering is a deliberate call, not an accident: the alias 503s constantly
  // and is an order of magnitude slower, so it went from first to last. It stays
  // in the ladder because it is the only entry that survives a deprecation.
  assert.equal(GEMINI_MODELS[0], "gemini-2.5-flash");
  assert.equal(GEMINI_MODELS.at(-1), "gemini-flash-latest");
});

test("every request turns thinking off", async () => {
  // Default thinking is what cut off the global digest: 11k thought tokens took
  // a 4.7s call past the request timeout, and only the local section survived.
  const { bodies, fetchImpl } = recorder(() => ok("digest"));
  await callGemini("p", opts(fetchImpl));
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingBudget, 0);
});

test("a caller can cap the ladder budget below the default", async () => {
  // digest.mjs gives the local section GEMINI_LOCAL_BUDGET_MS so that it cannot
  // spend the global digest's time.
  assert.ok(GEMINI_LOCAL_BUDGET_MS < GEMINI_BUDGET_MS);
  let clock = 0;
  const { calls, fetchImpl } = recorder(() => {
    clock += 60_000;
    return httpError(503);
  });
  await assert.rejects(() => callGemini("p", {
    ...opts(fetchImpl),
    budgetMs: GEMINI_LOCAL_BUDGET_MS,
    now: () => clock,
  }));
  assert.ok(calls.length <= 2, `a 120s budget must not fit more than two 60s attempts, got ${calls.length}`);
});

test("both ladders fit inside the workflow's 15-minute job timeout", () => {
  // digest.mjs makes two calls, local then global, plus feed fetching. Every
  // request is clamped to what is left of the budget, so a ladder cannot outlive
  // its own budget and the two budgets are the whole bound.
  const worstCase = GEMINI_LOCAL_BUDGET_MS + GEMINI_BUDGET_MS;
  assert.ok(worstCase < 13 * 60_000, `two ladders may take ${worstCase}ms, too close to the job limit`);
});
