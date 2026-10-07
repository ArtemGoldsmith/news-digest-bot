import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTPUT_DEFAULTS, loadConfig, normalizeConfig, resolveConfigPath } from "../lib/config.mjs";

const EXAMPLE = fileURLToPath(new URL("../digest.config.example.mjs", import.meta.url));
const base = { PERSONA: "A reader.", FEEDS: [{ url: "https://a/rss" }] };

test("the committed example config loads and validates", async () => {
  const { path, config } = await loadConfig({ env: { DIGEST_CONFIG_PATH: EXAMPLE } });
  assert.match(path, /digest\.config\.example\.mjs$/);
  assert.ok(config.persona.trim().length > 0);
  assert.ok(config.feeds.length > 0);
  assert.ok(config.local === null || typeof config.local.name === "string");
});

test("an absent local export disables the local section", () => {
  assert.equal(normalizeConfig(base).local, null);
  assert.equal(normalizeConfig({ ...base, local: null }).local, null);
});

test("local gets defaults for header, places, nearby and skipTopics", () => {
  const { local } = normalizeConfig({ ...base, local: { name: "Leeds", feeds: [{ url: "https://l/rss" }] } });
  assert.equal(local.header, "🏘 Leeds");
  assert.equal(local.places, null);
  assert.deepEqual(local.nearby, []);
  assert.deepEqual(local.skipTopics, []);
});

test("OUTPUT overrides are merged over the defaults", () => {
  const { output } = normalizeConfig({ ...base, OUTPUT: { language: "German" } });
  assert.equal(output.language, "German");
  assert.equal(output.title, OUTPUT_DEFAULTS.title);
});

test("a broken config fails loudly", () => {
  assert.throws(() => normalizeConfig({ FEEDS: [] }), /PERSONA/);
  assert.throws(() => normalizeConfig({ PERSONA: "x", FEEDS: [{}] }), /FEEDS/);
  assert.throws(() => normalizeConfig({ ...base, local: { feeds: [] } }), /local\.name/);
  assert.throws(() => normalizeConfig({ ...base, local: { name: "X" } }), /local\.feeds/);
});

test("the private config wins over the example; the example is the fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-cfg-"));
  assert.equal(resolveConfigPath({ env: {}, root: dir }), join(dir, "digest.config.example.mjs"));
  writeFileSync(join(dir, "digest.config.mjs"), "");
  assert.equal(resolveConfigPath({ env: {}, root: dir }), join(dir, "digest.config.mjs"));
});

test("a DIGEST_CONFIG_PATH that does not exist is an error, not a silent fallback", () => {
  assert.throws(() => resolveConfigPath({ env: { DIGEST_CONFIG_PATH: "/nonexistent/x.mjs" } }), /not found/);
});
