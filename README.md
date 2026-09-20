# fast-compaction-dsh

English | [中文](README.zh.md)

**Verdict-based context compaction for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).** Replaces the lossy compaction summary with fast per-call keep/truncate/drop decisions from [`jev-latest`](https://api.typesafe.ai) — everything kept stays **verbatim**, nothing is ever rewritten.

A DSH port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT), adapted to the DSH compaction capability seam.

![How it works](assets/flow.svg)

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is lossy: a file path, an exact error, a constraint, or a command can disappear even when it matters later. This plugin never rewrites anything. When compaction triggers, every tool call and tool result in the compacted region is scored by `jev-latest` through the TypeSafe System One endpoint; stale calls are deleted, half-stale results are truncated to a bounded head, and everything else stays byte-for-byte. User and assistant text is never removed.

On any failure — a missing `TYPESAFE_API_KEY`, a Jev error, malformed answers, an unfittable history, or an insufficient reduction — it falls back to the shipped `compaction-basic` summarizer, exactly like the original Claude Code hook falls back to Claude Code's built-in summary.

## How it works

1. Every `tool-call` is paired with its `tool-result` by call id. Calls in the first message and the newest `preserveRecentMessages` (default 6) messages are pinned and never touched.
2. The **state** sent to Jev is the whole compacted region, oldest first, with every tool result replaced by a short note (`ok, 4213 chars (omitted)`). Tool inputs and texts are included — nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k default) in stages: tool inputs truncated 1000 → 200 → 60 chars; long texts abridged to head + tail, oldest non-pinned first; old messages collapsed to a note; old calls reduced to one line each; old call-less messages left out; runs of call-only messages folded. If it still does not fit, the plugin falls back.
4. For every non-pinned call Jev gets two `noul` questions: should the **call** stay (knowing it was made, with its input, still matters), and should the **result** stay verbatim (its contents are still needed and re-running the tool would not do).
5. Questions are batched so state plus questions stays under `maxRequestTokens` (30k default); batches run concurrently and answers are merged.
6. Decisions against `keepThreshold` (default 0.5): `keepResult` ≥ threshold → keep both verbatim; else `keepCall` ≥ threshold → keep the call, truncate the result to its first `truncateHeadChars` (default 300) characters plus a note; else → drop the call together with its result.
7. The region is rebuilt as a verbatim transcript checkpoint (the DSH seam replaces the shadowed surface span with one durable user message), with role labels and the kept tool activity inline.

Measured on a real region: the Jev scoring round-trip takes **~700 ms**.

## How it plugs into DSH

DSH exposes compaction as a capability seam: `ctx.compaction` (service definition), an engine provider (`compaction-basic`), and the `/compact` consumer. The engine's single documented customization hook is `summarize()` — this plugin subclasses `BasicCompactionEngine` and overrides only that hook, so region selection, the durable transaction (lock, events, stability checks, shrink validation), checkpoint framing, and `/compact` keep working unchanged.

The shipped `standard` agent preset mounts `compaction-basic` inside an isolated `compaction` realm, so the engine row must be mounted from an **agent preset patch** — not from a profile-level `cordis.patch.yml`:

```yaml
# ~/.dsh/.agent-presets/fast/agent.cordis.yml
- id: standard
  name: cordis:include
  config:
    path: 'file:///path/to/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml'
    patches:
      - id: compaction-basic
        disabled: true
      - id: compaction
        insert:
          - id: fast-compaction
            name: 'file:///path/to/fast-compaction-dsh/src/index.ts'
            # config: { keepThreshold: 0.5, ... }   # all optional
```

Then point your default preset at it in `~/.dsh/cordis.patch.yml`:

```yaml
- id: agent-presets
  config:
    default: fast
```

Restart DSH. New sessions compact through `jev-latest`; watch the log for `fast-compaction-dsh: kept N/M calls verbatim (…)`.

## Requirements

- Node.js ≥ 22.19 (the plugin is TypeScript loaded directly by DSH's loader via type stripping).
- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout (developer preview) — for development and for the `link:` dev dependencies, clone it as a **sibling directory** of this repo (or adjust the `link:` paths in `package.json`).
- A TypeSafe API key: `export TYPESAFE_API_KEY=...` in the DSH process environment (or `apiKey` in the preset row's `config`). Without a key the plugin behaves exactly like `compaction-basic`.

## Configuration

All fields are optional and live under the preset row's `config:`. Unlisted fields pass through to `compaction-basic` (`thresholdRatio`, `retainRatio`, `retainTokens`, `summarizationProvider`, `summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`, `modelPolicies`, `auto`).

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `minReduction` | `0.25` | Fall back to the built-in summary below this reduction ratio |
| `disabled` | `false` | Use only the built-in summarizer |

## Differences from fast-jev-compaction

- The original rewrites Claude Code's message list in place. The DSH seam replaces the shadowed surface span with **one user message**, so the kept content is rebuilt as a verbatim transcript with role labels (`<user>` / `<assistant>` / `<tool-call>` / `<result>`). Text is still byte-for-byte.
- Assistant reasoning blocks are excluded from the transcript (intermediate thinking is not useful for resuming).
- Pinning is system-head aware: when `messages[0]` is the system message, the first conversational message is pinned with it.
- The Jev call does not go through DSH's `ctx.llm` seam; the summary result is recorded as a remote (unmarked) variant with `provider: 'typesafe'` and the Jev token usage.

## Development

```sh
pnpm install        # link: deps expect ../deepseek-harness to exist
pnpm run typecheck
pnpm test           # 42 unit/integration tests, no network
TYPESAFE_API_KEY=... node scripts/e2e.ts   # live verdict-path check against the real endpoint
```

Layout: `src/jev.ts` (System One transport + noul protocol), `src/state.ts` (fitted state), `src/pairing.ts` (call/result pairing), `src/rebuild.ts` (decisions + verbatim transcript), `src/index.ts` (the engine).

## License

MIT — see [LICENSE](LICENSE). Ported from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT); the `noul` question wording, state-fitting stages, and decision thresholds are carried over verbatim.
