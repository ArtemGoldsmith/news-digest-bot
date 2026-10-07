// Chunked digest delivery: Telegram rejects anything too long, in two separate
// ways, and the reader must not pay for either with lost links.

import { RAW_CHUNK_LIMIT, splitChunks } from "./format.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram does not document its entity budget, so RAW_CHUNK_LIMIT is only an
// estimate. When it turns out to be too generous, split the rejected chunk and
// retry rather than strip the markup: a digest arriving in three messages is
// fine, one arriving with every link stripped is not.
//
// The retry budget is half of what Telegram just refused, not half of our
// estimate — a chunk that already fits the estimate would not split at all,
// and the recursion would bottom out into plain text on the first rejection.
async function sendChunk(chunk, { send, visibleLimit, sleepImpl }) {
  try {
    await send(chunk, "HTML");
    return;
  } catch (e) {
    const target = Math.floor(chunk.length / 2);
    const parts = /TOO_LONG/.test(e.message) ? splitChunks(chunk, visibleLimit, target) : [chunk];
    if (parts.length === 1) {
      // Invalid HTML from the model, or a single line nothing can split —
      // degrade to plain text rather than fail.
      console.error(`HTML send failed (${e.message}), retrying as plain text`);
      await send(chunk.replace(/<[^>]+>/g, ""));
      return;
    }
    console.error(`HTML send failed (${e.message}), re-splitting into ${parts.length}`);
    for (const part of parts) {
      await sendChunk(part, { send, visibleLimit, sleepImpl });
      await sleepImpl(1000);
    }
  }
}

export async function sendDigest(text, {
  send,
  visibleLimit,
  rawLimit = RAW_CHUNK_LIMIT,
  sleepImpl = defaultSleep,
}) {
  for (const chunk of splitChunks(text, visibleLimit, rawLimit)) {
    await sendChunk(chunk, { send, visibleLimit, sleepImpl });
    await sleepImpl(1000);
  }
}
