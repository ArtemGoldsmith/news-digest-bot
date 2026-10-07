import test from "node:test";
import assert from "node:assert/strict";
import {
  capped,
  decodeEntities,
  freshDeduped,
  localAreaFilter,
  mentionsLocalArea,
  parseRss,
  stripHtml,
} from "../lib/feed.mjs";

const at = (hoursAgo, title, extra = {}) => ({
  title,
  link: extra.link ?? `https://a/${title}`,
  source: extra.source ?? "src",
  description: "",
  pubDate: new Date(Date.now() - hoursAgo * 3600_000),
});

test("decodeEntities unwraps CDATA and named entities", () => {
  assert.equal(decodeEntities("<![CDATA[ a &amp; b &lt;c&gt; ]]>"), "a & b <c>");
});

test("parseRss extracts the fields the digest uses", () => {
  const xml = `<rss><channel>
    <item><title>First</title><link>https://a/1</link><source>Deník</source>
      <pubDate>Tue, 12 Aug 2026 08:00:00 GMT</pubDate></item>
    <item><title>Second</title><link>https://a/2</link>
      <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "First");
  assert.equal(items[0].source, "Deník");
  assert.equal(items[1].source, "");
  assert.equal(items[0].pubDate.toISOString(), "2026-08-12T08:00:00.000Z");
});

test("parseRss skips items with no title", () => {
  assert.equal(parseRss("<item><link>https://a/1</link></item>").length, 0);
});

test("stripHtml removes tags and collapses whitespace", () => {
  assert.equal(stripHtml("<p>a  <b>b</b>\n c</p>"), "a b c");
});

test("parseRss extracts a stripped, 300-char-capped description", () => {
  const xml = `<item><title>T</title><description><![CDATA[<p>${"x".repeat(400)}</p>]]></description></item>`;
  assert.equal(parseRss(xml)[0].description.length, 300);
});

test("freshDeduped drops items outside the window", () => {
  const out = freshDeduped([at(1, "new"), at(100, "old")], { maxAgeHours: 26, staleFallback: false });
  assert.deepEqual(out.map((i) => i.title), ["new"]);
});

test("freshDeduped collapses titles differing only in case and punctuation", () => {
  const out = freshDeduped([at(1, "Crème brûlée à la française"), at(2, "CRÈME, brûlée à la française!")], {
    maxAgeHours: 26, staleFallback: false,
  });
  assert.equal(out.length, 1);
});

test("freshDeduped sorts newest first", () => {
  const out = freshDeduped([at(5, "older"), at(1, "newer")], { maxAgeHours: 26, staleFallback: false });
  assert.deepEqual(out.map((i) => i.title), ["newer", "older"]);
});

test("staleFallback:true keeps everything when nothing is fresh", () => {
  assert.equal(freshDeduped([at(100, "old")], { maxAgeHours: 26, staleFallback: true }).length, 1);
});

test("staleFallback:false returns empty rather than resurrecting old local news", () => {
  assert.equal(freshDeduped([at(100, "old")], { maxAgeHours: 72, staleFallback: false }).length, 0);
});

test("capped truncates and freshDeduped does not", () => {
  const items = Array.from({ length: 10 }, (_, i) => at(i + 1, `t${i}`));
  assert.equal(freshDeduped(items, { maxAgeHours: 26, staleFallback: false }).length, 10);
  assert.equal(capped(items, 3).length, 3);
});

const PLACES = ["bristol", "clifton", "bedminster", "\\bkeynsham"];

test("mentionsLocalArea keeps genuinely local stories", () => {
  for (const title of [
    "Fire crews tackle blaze at Bedminster warehouse",
    "Driver falls asleep at a junction in central Bristol",
    "Clifton Suspension Bridge to close for repairs",
    "Keynsham library reopens after refurbishment",
  ]) {
    assert.ok(mentionsLocalArea({ title, description: "", source: "" }, PLACES), title);
  }
});

test("mentionsLocalArea drops nationwide and international filler", () => {
  for (const title of [
    "Inflation rises again as economists sound the alarm",
    "Heatwave warning issued for the whole country",
    "Trade talks stall in Brussels",
  ]) {
    assert.equal(mentionsLocalArea({ title, description: "", source: "" }, PLACES), false, title);
  }
});

test("mentionsLocalArea matches on description and on source", () => {
  assert.ok(mentionsLocalArea({ title: "Road closure", description: "Works in Bristol last until September", source: "" }, PLACES));
  assert.ok(mentionsLocalArea({ title: "New exhibition", description: "", source: "Bristol Post" }, PLACES));
});

test("an official feed bypasses the locality check", () => {
  assert.ok(mentionsLocalArea({ title: "Road closure on Hill Street", description: "", source: "", official: true }, PLACES));
});

test("places are matched case-insensitively and with unicode", () => {
  const f = localAreaFilter(["zürich"]);
  assert.ok(f({ title: "Neues Tram in ZÜRICH", description: "", source: "" }));
});

test("places may be given as a RegExp, and a /g flag does not make matching stateful", () => {
  const f = localAreaFilter(/bristol/gi);
  const item = { title: "Bristol news", description: "", source: "" };
  assert.ok(f(item));
  assert.ok(f(item), "second call must match too");
});

test("no places configured means no geographic filter", () => {
  const item = { title: "Anything at all", description: "", source: "" };
  assert.ok(localAreaFilter(undefined)(item));
  assert.ok(localAreaFilter([])(item));
});

test("a place list for one city does not match another", () => {
  assert.equal(mentionsLocalArea({ title: "Bristol council budget", description: "", source: "" }, ["leeds"]), false);
});

test("parseRss strips the Google News ' - Publisher' suffix so dedup keys match", () => {
  const gnews = parseRss(
    "<item><title>Car break-in reported in Clifton - Bristol Post</title>" +
    "<source>Bristol Post</source><link>https://n/1</link></item>",
  )[0];
  const native = parseRss("<item><title>Car break-in reported in Clifton</title><link>https://d/1</link></item>")[0];
  assert.equal(gnews.title, native.title);
  assert.equal(gnews.source, "Bristol Post");
});

test("parseRss leaves a title alone when it does not end with the source", () => {
  const i = parseRss("<item><title>Fire - crews on scene</title><source>Local Herald</source></item>")[0];
  assert.equal(i.title, "Fire - crews on scene");
});
