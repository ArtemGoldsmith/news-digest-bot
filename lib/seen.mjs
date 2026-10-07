// Cross-run dedup: stable per-item keys plus the client for the worker's
// /seen endpoints. Every network failure degrades to "nothing seen" — a
// repeated item is noise, a digest that fails to send is not.

import { createHash } from "node:crypto";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_KEYS_PER_REQUEST = 200;

const hash16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Matches digest.mjs's existing in-run dedup key, plus a trim so leading
// punctuation cannot produce a leading space.
//
// Do NOT add .normalize("NFKD") here: it decomposes diacritics into a base
// letter plus a combining mark, and the mark is \p{M} — neither \p{L} nor
// \p{N} — so the character class below turns "Crème brûlée" into
// "cre me bru le e".
export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 80);
}

export function itemKeys(item) {
  const keys = [`t:${hash16(normalizeTitle(item.title))}`];
  if (item.link) keys.push(`u:${hash16(item.link)}`);
  return keys;
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

// Duplicates are removed before sending: two cited items can share a link key,
// and Workers KV rejects more than one write per second to the same key, which
// would fail the whole Promise.all batch on the worker side.
const uniq = (keys) => [...new Set(keys)];

// An unmatched worker path returns HTTP 200 "news-digest-bot", so a wrong URL
// would read as a valid empty answer. new URL() against the origin keeps the
// path absolute instead of appending to INGEST_URL's own /ingest path.
async function post(path, { ingestUrl, secret }, body) {
  const res = await fetch(new URL(path, ingestUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Secret": secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkSeen(keys, cfg) {
  const seen = new Set();
  const unique = uniq(keys);
  if (!cfg.ingestUrl || !cfg.secret || unique.length === 0) return seen;
  try {
    for (const part of chunk(unique, MAX_KEYS_PER_REQUEST)) {
      const data = await post("/seen/check", cfg, { keys: part });
      if (!Array.isArray(data?.seen) || !data.seen.every((k) => typeof k === "string")) {
        throw new Error("malformed response");
      }
      for (const k of data.seen) seen.add(k);
    }
  } catch (e) {
    console.error(`seen check failed (${e.message}) — treating as nothing seen`);
    return new Set();
  }
  return seen;
}

export async function markSeen(keys, cfg) {
  const unique = uniq(keys);
  if (!cfg.ingestUrl || !cfg.secret || unique.length === 0) return;
  try {
    for (const part of chunk(unique, MAX_KEYS_PER_REQUEST)) {
      const data = await post("/seen/mark", cfg, { keys: part });
      if (data?.ok !== true) throw new Error("malformed response");
    }
  } catch (e) {
    console.error(`seen mark failed (non-fatal): ${e.message}`);
  }
}

// Kept here, and kept pure, so the "filter before cap" ordering is testable
// rather than living inline in digest.mjs where no test can reach it.
export function selectLocal(candidates, seen, maxItems) {
  return candidates
    .filter((item) => !itemKeys(item).some((k) => seen.has(k)))
    .slice(0, maxItems);
}
