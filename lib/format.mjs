// Text and HTML shaping for the Telegram payload.

export const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Telegram's limit counts characters AFTER entity parsing, so measure visible
// text: an <a href> to Google News is ~600 raw chars but ~10 visible.
export const visibleLen = (s) => s.replace(/<[^>]+>/g, "").length;

// Telegram caps the combined weight of a message's entities separately from
// its visible text, and answers ENTITIES_TOO_LONG when the markup is too heavy.
// Google News hrefs are 400+ char base64 blobs, so a chunk can sit well inside
// the visible budget and still be rejected — after which sendDigest degrades it
// to plain text and the reader loses every link.
export const RAW_CHUNK_LIMIT = 8000;

// Pack whole lines: a cut inside an <a> tag makes Telegram reject the chunk,
// and tags never span lines in our output. A single line that busts either
// budget on its own is still emitted whole — splitting it is the worse failure.
export function splitChunks(text, limit, rawLimit = RAW_CHUNK_LIMIT) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? current + "\n" + line : line;
    if (visibleLen(candidate) <= limit && candidate.length <= rawLimit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Replaces {{N}} refs with real links: at most 3 per line, deduped by source,
// comma-separated after a single dash. Numbering is per-pool — the global and
// local sections come from separate model calls and both start at 1.
//
// citedIndices feeds the cross-run dedup, so it must list every ref that
// resolved to a real item — including ones the 3-link cap dropped, since the
// story was still selected and sent.
export function substituteLinks(text, pool) {
  let missing = 0;
  const cited = new Set();
  const out = text
    .split("\n")
    .map((line) => {
      const refs = [...new Set([...line.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))];
      if (refs.length === 0) return line;
      const stripped = line.replace(/[—\-\s]*\{\{\s*\d+\s*\}\}[.,\s]*/g, " ").replace(/\s+$/, "");

      const valid = refs.filter((n) => pool[n - 1]);
      missing += refs.length - valid.length;
      for (const n of valid) cited.add(n - 1);

      const links = [];
      const usedSources = new Set();
      for (const n of valid) {
        const item = pool[n - 1];
        const source = item.source || "source";
        if (usedSources.has(source)) continue;
        usedSources.add(source);
        links.push(`<a href="${escapeHtml(item.link)}">${escapeHtml(source)}</a>`);
        if (links.length >= 3) break;
      }
      return links.length ? `${stripped} — ${links.join(", ")}` : stripped;
    })
    .join("\n");
  if (missing) console.error(`substituteLinks: ${missing} unknown {{N}} references dropped`);
  return { text: out, citedIndices: [...cited] };
}

// Empty string when there is no local section: a failed local path must NOT
// strip the city from the global digest too, or the story vanishes entirely.
export const localExclusionRule = (hasLocalSection, localName) =>
  hasLocalSection && localName
    ? `- Skip stories about ${localName} — they have their own section below.\n`
    : "";
