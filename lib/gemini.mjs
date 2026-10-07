// Gemini text generation with a model fallback ladder and bounded retries.

// Ordered fastest first for a full-size headline prompt. The "latest" alias is
// last because it tends to be the slowest and busiest endpoint (frequent 503s);
// it stays in the ladder at all because it is the only entry that survives a
// model deprecation.
export const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
];

// Picking and retelling headlines needs no deliberation, and the thinking these
// models do by default can multiply latency several times over and push a call
// past the request timeout. thinkingLevel is not an alternative — 2.5-flash
// rejects it with HTTP 400.
export const GEMINI_THINKING_CONFIG = { thinkingBudget: 0 };

// Room for a slow model, not a promise that one will be fast: the ladder budget
// is what bounds the run. A tighter timeout can cut off every call for the
// long global prompt while the shorter local prompt still fits, and the digest
// would then arrive with the local section alone.
export const GEMINI_TIMEOUT_MS = 90_000;
// The whole ladder, not one request.
export const GEMINI_BUDGET_MS = 300_000;
// Local runs before global inside a 15-minute job, so the local ladder gets a
// smaller share: whatever goes wrong, the main digest keeps its full budget and
// the local section is the part that loses.
export const GEMINI_LOCAL_BUDGET_MS = 120_000;

const MAX_ATTEMPTS = 3;
// Below this there is no point firing a request the budget will cut off.
const MIN_ATTEMPT_MS = 5_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callGemini(prompt, {
  apiKey,
  models = GEMINI_MODELS,
  timeoutMs = GEMINI_TIMEOUT_MS,
  budgetMs = GEMINI_BUDGET_MS,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + budgetMs;
  const remaining = () => deadline - now();
  let lastError;

  for (const [index, model] of models.entries()) {
    // An equal share of what is left, so one hanging model cannot spend the
    // whole ladder: at a 90s request timeout three attempts on the first model
    // used up all 300s and the fallbacks were never reached at all.
    // Floored: AbortSignal.timeout rejects a fractional delay outright
    // (ERR_OUT_OF_RANGE), which would burn the attempt without a request.
    const modelDeadline = now() + Math.floor(remaining() / (models.length - index));
    const modelRemaining = () => Math.min(deadline, modelDeadline) - now();
    // Cleared if this model rejects the switch; see the 400 branch below.
    let thinking = GEMINI_THINKING_CONFIG;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (remaining() < MIN_ATTEMPT_MS) {
        throw new Error(`Gemini time budget spent. Last error: ${lastError}`);
      }
      if (modelRemaining() < MIN_ATTEMPT_MS) break; // this model's share is spent
      let transient = true;
      let backoff = true;
      try {
        const res = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              ...(thinking ? { generationConfig: { thinkingConfig: thinking } } : {}),
            }),
            signal: AbortSignal.timeout(Math.min(timeoutMs, modelRemaining())),
          },
        );
        if (res.ok) {
          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
          if (text.trim()) {
            console.log(`gemini ok: ${model} (attempt ${attempt})`);
            return text.trim();
          }
          lastError = `empty response from ${model}`;
        } else {
          lastError = `${model} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
          console.error(lastError);
          // 429/503 are transient — back off and retry; anything else — try next model
          transient = res.status === 429 || res.status === 503;
          // Google documents thinkingBudget as merely backward-compatible on
          // Gemini 3. It works on every model in the ladder, but the alias
          // moves: rather than let a future target
          // take the whole ladder down, drop the switch and retry at once.
          if (res.status === 400 && thinking && /thinking/i.test(lastError)) {
            thinking = null;
            transient = true;
            backoff = false;
            attempt--; // dropping the switch is not one of the model's attempts
          }
        }
      } catch (e) {
        // Timeouts and socket errors are exactly what this ladder exists for.
        // Without this catch the DOMException escapes both loops, the fallback
        // models are never tried and the whole run dies.
        lastError = `${model} -> ${e.message}`;
        console.error(lastError);
      }
      if (!transient) break;
      if (attempt === MAX_ATTEMPTS) break; // no point sleeping before switching model
      if (backoff) await sleepImpl(Math.max(0, Math.min(15_000 * attempt, modelRemaining())));
    }
  }
  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}
