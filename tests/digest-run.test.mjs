// Runs digest.mjs end to end with a config that has no feeds, so no network is
// touched: it proves the "no local config" path skips the section cleanly.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = fileURLToPath(new URL("../digest.mjs", import.meta.url));

function run(configSource) {
  const dir = mkdtempSync(join(tmpdir(), "digest-run-"));
  const cfg = join(dir, "digest.config.mjs");
  writeFileSync(cfg, configSource);
  return spawnSync(process.execPath, [DIGEST], {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH, DRY_RUN: "1", GEMINI_API_KEY: "dummy", DIGEST_CONFIG_PATH: cfg },
  });
}

test("no local config: the local section is skipped and the run exits cleanly", () => {
  const r = run(`export const PERSONA = "A reader."; export const FEEDS = [];`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /local: not configured, section skipped/);
  assert.match(r.stdout, /0 global, 0 local items/);
  assert.match(r.stdout, /DRY_RUN would send/);
});

test("local configured with no feeds: the pool is empty and the section is skipped", () => {
  const r = run(`export const PERSONA = "A reader."; export const FEEDS = [];
    export const local = { name: "Leeds", feeds: [] };`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /local: pool empty, section skipped/);
});
