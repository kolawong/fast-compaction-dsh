# Web halves (settings namespace + settings card)

This directory holds the **web-profile entries of the `fast-compaction-dsh` package** — the same package that ships the agent-side engine in `../src/`. One package, three entry points:

| Entry | File | Loaded by | Job |
| --- | --- | --- | --- |
| `fast-compaction-dsh` | `../src/index.ts` | the agent preset (compaction isolate realm) | the verdict compaction engine |
| `fast-compaction-dsh/web` | `server.js` | the web profile bundle patch (`../cordis.patch.yml`) | registers the `fast-compaction` settings namespace on the web profile's settings provider |
| `fast-compaction-dsh/client` | `client.js` | the browser | the bilingual settings card on the Plugins page |

`server.js` carries the namespace schema (`apiKey` is a `role('secret')` field — only a set/unset flag ever crosses the wire) and a base layer of code defaults plus `TYPESAFE_API_KEY` when the environment provides it. `client.js` edits the namespace through the bound settings scope's `mutate` (revision-fenced, with read-back conflict detection), and states prominently that changes apply to subsequent compactions live — the engine hot-reads `~/.dsh/settings.yaml`, so no restart is needed.

Install (already done on this deployment): the web profile depends on the package itself,

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "fast-compaction-dsh": "link:/root/fast-compaction-dsh" },
"dsh": { "profile": { "bundles": [ ..., "fast-compaction-dsh" ] } }
```

then restart DSH. The `fast-compaction-dsh` row on the Plugins page owns the Configure card; the engine half stays mounted by the `fast` agent preset exactly as before — the web profile never loads `src/index.ts`.
