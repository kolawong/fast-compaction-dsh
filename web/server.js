/**
 * fast-compaction-dsh — Web-profile entry (the package's `./web` export).
 *
 * Owns exactly one job: registering the `fast-compaction` settings namespace
 * with the deployment's settings provider (`@deepseek-ai/dsh-settings-file`
 * on ~/.dsh/settings.yaml), so that
 *
 *   1. the agent-side engine half of this same package (src/index.ts) gets a
 *      validated, layered section (schema defaults → this entry's base layer
 *      → user layer), and
 *   2. the Web settings card (web/client.js) has a namespace to render and edit.
 *
 * The registration is deliberately defensive: when no settings provider is
 * mounted, `ctx.inject` parks the callback instead of failing the plugin, and
 * any failure inside `register` (duplicate owner, invalid stored section)
 * warns and leaves the rest of the profile untouched.
 *
 * @license MIT
 */

import Schema from "@deepseek-ai/schemastery";

/** Settings namespace name; the Web settings card pairs the card by this key. */
export const NS = "fast-compaction";

/** Environment variable the base layer sources the API key from. */
export const API_KEY_ENV_VAR = "TYPESAFE_API_KEY";

/**
 * Code defaults, shared by the schema (so a missing key resolves) and the
 * base layer (so the card shows what a field reverts to). `apiKey` is absent
 * on purpose: a secret with no default stays out of the resolved value until
 * the environment or the user sets one, which keeps the wire-side
 * `secrets[].set` flag truthful ("set" exactly when a key exists).
 */
export const DEFAULTS = Object.freeze({
  disabled: false,
  model: "jev-latest",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  minReduction: 0.25,
});

/**
 * Namespace schema. Every field is optional (a missing key resolves through
 * the default); the user layer only carries overrides. `apiKey` is marked
 * `role('secret')` so every wire surface (`describe({redactSecrets: true})`)
 * strips it and reports only the set/unset flag.
 */
export const Config = Schema.object({
  /** Verdict-path switch: true keeps compacting but always with the built-in summarizer. */
  disabled: Schema.boolean().default(DEFAULTS.disabled),
  /** Upstream API key; write-only on the wire (redacted). */
  apiKey: Schema.string().role("secret"),
  /** Model the verdict calls target. */
  model: Schema.string().default(DEFAULTS.model),
  /** System One endpoint the verdict calls target. */
  baseUrl: Schema.string().default(DEFAULTS.baseUrl),
  /** Minimum keep probability for a tool call or result to survive. */
  keepThreshold: Schema.number().min(0).max(1).default(DEFAULTS.keepThreshold),
  /** Newest messages never touched (the first is always kept). */
  preserveRecentMessages: Schema.natural().default(DEFAULTS.preserveRecentMessages),
  /** Estimated token ceiling of the history state sent to the verdict model. */
  maxStateTokens: Schema.natural().min(1).default(DEFAULTS.maxStateTokens),
  /** Estimated token ceiling of one verdict request (state plus one batch of questions). */
  maxRequestTokens: Schema.natural().min(1).default(DEFAULTS.maxRequestTokens),
  /** Head characters retained from a dropped tool result before its truncation note. */
  truncateHeadChars: Schema.natural().default(DEFAULTS.truncateHeadChars),
  /** Below this reduction ratio the verdict pass falls back to the built-in summary. */
  minReduction: Schema.number().min(0).max(1).default(DEFAULTS.minReduction),
});

/**
 * The composition `base` layer. apiKey joins the layer only when the
 * environment actually provides one — an empty-string base would make the
 * redacted `secrets[].set` flag report "set" forever.
 * @returns {Record<string, unknown>} detached base section.
 */
export function baseLayer() {
  const envKey = String(process.env[API_KEY_ENV_VAR] ?? "").trim();
  return {
    ...DEFAULTS,
    ...(envKey === "" ? {} : { apiKey: envKey }),
  };
}

/**
 * Plugin activation. The patch entry already declares `inject: [settings]`;
 * the inner `ctx.inject` is a second, cheap guard so this module also behaves
 * when loaded without the gate (callback parks until a provider mounts rather
 * than throwing). `applies: 'live'` because the engine hot-reads
 * settings.yaml on every compaction pass — no restart needed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger;
  ctx.inject(["settings"], (inner) => {
    try {
      inner.settings.register(NS, Config, { base: baseLayer(), applies: "live" });
    } catch (error) {
      logger?.warn?.("[fast-compaction] settings namespace registration failed; continuing without it:", error);
    }
  });
}
