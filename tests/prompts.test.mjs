import test from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_DEFAULTS, normalizeConfig } from "../lib/config.mjs";
import { digestPrompt, localPrompt } from "../lib/prompts.mjs";

const { local } = normalizeConfig({
  PERSONA: "x",
  FEEDS: [],
  local: {
    name: "Leeds",
    feeds: [{ url: "https://l/rss" }],
    nearby: ["Otley", "Wetherby"],
    skipTopics: ["sport — football, rugby league"],
  },
});

test("the local prompt is built from config: city, nearby places, skip topics, header", () => {
  const p = localPrompt({ local, output: OUTPUT_DEFAULTS, newsList: "1. item", noneToken: "NONE" });
  assert.match(p, /local news column about Leeds/);
  assert.match(p, /Otley, Wetherby/);
  assert.match(p, /Drop entirely: sport — football, rugby league\./);
  assert.match(p, /<b>🏘 Leeds<\/b>/);
  assert.match(p, /exactly one word: NONE/);
  assert.match(p, /1\. item$/);
});

test("without nearby places the local prompt restricts to the city itself", () => {
  const p = localPrompt({ local: { ...local, nearby: [], skipTopics: [] }, output: OUTPUT_DEFAULTS, newsList: "", noneToken: "NONE" });
  assert.match(p, /Only stories about Leeds itself qualify/);
  assert.doesNotMatch(p, /Drop entirely/);
});

test("the digest prompt carries persona, language, title and the exclusion rule", () => {
  const p = digestPrompt({
    persona: "\nLikes AI.\n",
    output: { ...OUTPUT_DEFAULTS, language: "German" },
    today: "1 May 2026",
    newsList: "1. item",
    exclusionRule: "- Skip stories about Leeds.\n",
  });
  assert.match(p, /READER PROFILE:\nLikes AI\.\n/);
  assert.match(p, /digest in German/);
  assert.match(p, /<b>📰 Digest — 1 May 2026<\/b>/);
  assert.match(p, /- Skip stories about Leeds\.\n- Each story/);
});
