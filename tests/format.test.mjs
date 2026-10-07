import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  localExclusionRule,
  splitChunks,
  substituteLinks,
  visibleLen,
} from "../lib/format.mjs";

test("escapeHtml escapes the four HTML-significant characters", () => {
  assert.equal(escapeHtml(`a & b < c > d "e"`), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("visibleLen ignores tags", () => {
  assert.equal(visibleLen(`<a href="https://very.long/url">src</a>`), 3);
});

test("splitChunks packs whole lines and never splits one", () => {
  const line = "x".repeat(30);
  const chunks = splitChunks([line, line, line].join("\n"), 70);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], [line, line].join("\n"));
  assert.equal(chunks[1], line);
});

test("splitChunks measures visible length, not raw HTML", () => {
  const long = `<a href="${"u".repeat(500)}">s</a>`;
  assert.equal(splitChunks(`${long}\n${long}`, 100).length, 1);
});

const pool = [
  { title: "A", link: "https://a", source: "SrcA" },
  { title: "B", link: "https://b", source: "SrcB" },
  { title: "C", link: "https://c", source: "SrcC" },
  { title: "D", link: "https://d", source: "SrcD" },
];

test("substituteLinks replaces a ref with a source link", () => {
  const { text, citedIndices } = substituteLinks("Something happened {{1}}", pool);
  assert.equal(text, `Something happened — <a href="https://a">SrcA</a>`);
  assert.deepEqual(citedIndices, [0]);
});

test("substituteLinks caps at three links but still reports every cited item", () => {
  const { text, citedIndices } = substituteLinks("Event {{1}} {{2}} {{3}} {{4}}", pool);
  assert.equal((text.match(/<a /g) ?? []).length, 3);
  assert.deepEqual(citedIndices, [0, 1, 2, 3]);
});

test("substituteLinks dedupes by source", () => {
  const dupes = [{ link: "https://a", source: "Same" }, { link: "https://b", source: "Same" }];
  const { text, citedIndices } = substituteLinks("X {{1}} {{2}}", dupes);
  assert.equal((text.match(/<a /g) ?? []).length, 1);
  assert.deepEqual(citedIndices, [0, 1]);
});

test("substituteLinks drops refs outside the pool and does not cite them", () => {
  const { text, citedIndices } = substituteLinks("X {{99}}", pool);
  assert.equal(text, "X");
  assert.deepEqual(citedIndices, []);
});

test("substituteLinks leaves a line with no refs untouched and cites nothing", () => {
  const { text, citedIndices } = substituteLinks("<b>Headline</b>", pool);
  assert.equal(text, "<b>Headline</b>");
  assert.deepEqual(citedIndices, []);
});

test("substituteLinks escapes the URL and source", () => {
  const nasty = [{ link: `https://a?x=1&y=2`, source: `A & <B>` }];
  const { text } = substituteLinks("X {{1}}", nasty);
  assert.match(text, /href="https:\/\/a\?x=1&amp;y=2"/);
  assert.match(text, /&gt;/);
});

test("substituteLinks numbers against the pool it is given, not a global one", () => {
  assert.deepEqual(substituteLinks("X {{1}}", [pool[2]]).citedIndices, [0]);
  assert.match(substituteLinks("X {{1}}", [pool[2]]).text, /SrcC/);
});

test("localExclusionRule is emitted only when a local section exists", () => {
  assert.match(localExclusionRule(true, "Bristol"), /Bristol/);
  assert.equal(localExclusionRule(null, "Bristol"), "");
  assert.equal(localExclusionRule(undefined, "Bristol"), "");
});

test("localExclusionRule names the configured city, not a hard-coded one", () => {
  assert.match(localExclusionRule(true, "Leeds"), /stories about Leeds/);
  assert.doesNotMatch(localExclusionRule(true, "Leeds"), /Bristol/);
});

test("localExclusionRule is empty when no local name is configured", () => {
  assert.equal(localExclusionRule(true, undefined), "");
});

test("splitChunks also caps raw size, so link-heavy chunks stay under Telegram's entity limit", () => {
  // Google News hrefs are 400+ char base64 blobs. Twenty of them clear the
  // visible-length budget easily and still blow Telegram's entity limit, which
  // it answers with ENTITIES_TOO_LONG.
  const line = `article <a href="https://news.google.com/${"u".repeat(450)}">provider</a>`;
  const chunks = splitChunks(Array(20).fill(line).join("\n"), 4000);
  assert.ok(chunks.length > 1, "a link-heavy digest must be split, not sent as one oversized chunk");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 8000, `raw chunk of ${chunk.length} chars exceeds the entity budget`);
  }
});

test("splitChunks still never splits a single line, even one over the raw cap", () => {
  const huge = `<a href="${"u".repeat(9000)}">s</a>`;
  assert.deepEqual(splitChunks(huge, 4000), [huge]);
});
