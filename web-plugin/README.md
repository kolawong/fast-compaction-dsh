# dsh-plugin-fast-compaction

A DeepSeek Harness (DSH) **web-profile plugin** that adds a settings card for the
[`fast-compaction-dsh`](https://github.com/) agent-side compaction engine (this repository's
`src/index.ts`).

It does two things:

1. **Server half (`index.js`)** — registers the `fast-compaction` settings namespace
   (schemastery schema, composition `base` layer with the code defaults, `applies: 'live'`)
   with the deployment's settings provider, so `~/.dsh/settings.yaml` gains a validated,
   layered `fast-compaction:` section. The `apiKey` field is marked `role('secret')`: it
   never crosses the wire; clients only see a set/unset flag. The base layer sources the
   key from `process.env.TYPESAFE_API_KEY` when present.
2. **Client half (`client.js`)** — renders the card on the Web Plugins page
   (`plugins.bundle.config` / `plugins.row.config`, plus the legacy `settings.plugin.item`
   slot), bilingual (zh default + en). All fields are editable with staged drafts and a
   save button; writes go through the client settings scope
   (`scope.mutate` → `ctx.remote.settings.mutate(ns, ops, expectedRevision)`), so a stale
   editor is refused with `settings/conflict` and the card reloads the accepted values.
   "Reset to defaults" unsets every field, letting each re-inherit the base/default.

Changes apply **live** to subsequent compactions — the engine hot-reads `settings.yaml`;
no restart is needed.

## Fields

| Field | Default | Notes |
|---|---|---|
| `disabled` | `false` | Master switch for the engine. |
| `apiKey` | `$TYPESAFE_API_KEY` | Secret; write-only from the card, clearable. |
| `model` | `jev-latest` | Compaction model. |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | OpenAI-compatible endpoint. |
| `keepThreshold` | `0.5` | Context-fill fraction that triggers compaction (0–1). |
| `preserveRecentMessages` | `6` | Tail messages always kept verbatim (integer ≥ 0). |
| `maxStateTokens` | `25000` | Token budget of the compacted state block (≥ 1). |
| `maxRequestTokens` | `30000` | Token budget of one compaction request (≥ 1). |
| `truncateHeadChars` | `300` | Head characters kept from an oversized item (≥ 0). |
| `minReduction` | `0.25` | Minimum accepted size reduction (0–1). |

## Install

Either install the local path with the DSH plugin manager, or wire it into the web
profile manually:

```sh
cd ~/.dsh/profiles/web
pnpm add file:/path/to/fast-compaction-dsh/web-plugin   # link:… while developing
# add "dsh-plugin-fast-compaction" to the dsh.profile.bundles list in package.json
# restart the profile (e.g. systemctl restart deepseek-harness.service)
```

The bundle patch (`cordis.patch.yml`) inserts the server entry; the client bundle is
picked up from the package's `dsh.client` declaration after a browser hard refresh.

## Relationship to fast-compaction-dsh

The engine (agent-side, this repo's root package) reads the same `fast-compaction`
namespace from `~/.dsh/settings.yaml`. This plugin only owns the namespace registration
and the configuration UI on the machine's web profile — it contains no compaction logic.
Uninstalling it leaves the engine running on its own code defaults.
