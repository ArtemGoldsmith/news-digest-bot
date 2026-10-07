// Loads the personal tuning (persona, feeds, local section) from a config
// module so it never has to live in committed code.
//
// Resolution order:
//   1. $DIGEST_CONFIG_PATH, if set (must exist)
//   2. ./digest.config.mjs (gitignored; CI writes it from the DIGEST_CONFIG secret)
//   3. ./digest.config.example.mjs (committed, neutral example)

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OUTPUT_DEFAULTS = {
  language: "English",
  locale: "en-GB",
  timeZone: "UTC",
  title: "📰 Digest",
  topics: "🤖 AI, 💻 Dev, 🌍 World, 🔬 Science",
};

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function resolveConfigPath({ env = process.env, root = ROOT } = {}) {
  if (env.DIGEST_CONFIG_PATH) {
    const p = resolve(env.DIGEST_CONFIG_PATH);
    if (!existsSync(p)) throw new Error(`DIGEST_CONFIG_PATH not found: ${p}`);
    return p;
  }
  const own = resolve(root, "digest.config.mjs");
  return existsSync(own) ? own : resolve(root, "digest.config.example.mjs");
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

function validFeeds(feeds, where) {
  if (!Array.isArray(feeds) || !feeds.every((f) => isNonEmptyString(f?.url))) {
    throw new Error(`config: ${where} must be an array of { url } objects`);
  }
  return feeds;
}

// A missing or null `local` export is a valid choice: the local section is
// skipped entirely. A present-but-broken one fails loudly instead of silently
// dropping the section.
export function normalizeConfig(mod) {
  if (!isNonEmptyString(mod.PERSONA)) throw new Error("config: PERSONA must be a non-empty string");
  const feeds = validFeeds(mod.FEEDS, "FEEDS");
  const output = { ...OUTPUT_DEFAULTS, ...(mod.OUTPUT ?? {}) };

  let local = null;
  if (mod.local) {
    const l = mod.local;
    if (!isNonEmptyString(l.name)) throw new Error("config: local.name must be a non-empty string");
    local = {
      name: l.name,
      header: l.header ?? `🏘 ${l.name}`,
      feeds: validFeeds(l.feeds, "local.feeds"),
      places: l.places ?? null,
      nearby: l.nearby ?? [],
      skipTopics: l.skipTopics ?? [],
    };
  }
  return { persona: mod.PERSONA, feeds, output, local };
}

export async function loadConfig(opts) {
  const path = resolveConfigPath(opts);
  const mod = await import(pathToFileURL(path).href);
  return { path, config: normalizeConfig(mod) };
}
