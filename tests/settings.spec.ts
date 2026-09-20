import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FastCompactionEngine, mergeFastConfig } from '../src/index.ts'
import type { FastCompactionConfig } from '../src/index.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev.ts'

/** A Jev double the settings tests never actually call. */
class StubAsker implements JevAsker {
  ask(_state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const answers: Record<string, { type: 'noul'; noul: number }> = {}
    for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul: 1 }
    return Promise.resolve({ model: 'stub', answers })
  }
}

/** Engine with the transport stubbed out; exposes the resolved fast config. */
class TestEngine extends FastCompactionEngine {
  constructor(ctx: Context, config: FastCompactionConfig & Partial<BasicCompactionConfig> = {}) {
    super(ctx, { apiKey: 'tsk-test', ...config })
  }

  protected override createJevAsker(): JevAsker {
    return new StubAsker()
  }
}

/** Minimal llm runtime so the inherited service constructor finds its seams. */
class StubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'unused' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  delete process.env.TYPESAFE_API_KEY
})

/** Boot a context with the file-backed settings provider over a fresh document. */
async function boot(document?: string): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'fast-compaction-settings-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'settings.yaml')
  if (document !== undefined) await writeFile(path, document)
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['fake'], new StubAdapter())
  const fiber = ctx.plugin(FileSettingsProvider, { path, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('mergeFastConfig', () => {
  it('overlays defined fields only, leaving base values under undefined', () => {
    const merged = mergeFastConfig(
      { keepThreshold: 0.5, model: 'jev-latest', maxStateTokens: 1234 },
      { keepThreshold: 0.8, model: undefined },
    )
    expect(merged).toEqual({ keepThreshold: 0.8, model: 'jev-latest', maxStateTokens: 1234 })
  })
})

describe('FastCompactionEngine settings layer', () => {
  it('resolves the stored user layer per-field over the composition config', async () => {
    const ctx = await boot('fast-compaction:\n  keepThreshold: 0.8\n  model: jev-x\n')
    const engine = new TestEngine(ctx, { keepThreshold: 0.5, maxStateTokens: 1234 })
    await vi.waitFor(() => {
      expect(engine.fast.keepThreshold).toBe(0.8)
    })
    expect(engine.fast.model).toBe('jev-x')
    expect(engine.fast.maxStateTokens).toBe(1234)
  })

  it('falls back to TYPESAFE_API_KEY, and the user layer beats both env and preset config', async () => {
    process.env.TYPESAFE_API_KEY = 'tsk-env'
    const ctx = await boot('fast-compaction:\n  apiKey: tsk-user\n')
    const layered = new TestEngine(ctx, { apiKey: undefined })
    await vi.waitFor(() => {
      expect(layered.fast.apiKey).toBe('tsk-user')
    })
  })

  it('falls back to the env key when the user layer does not set apiKey', async () => {
    process.env.TYPESAFE_API_KEY = 'tsk-env'
    const ctx = await boot('fast-compaction:\n  keepThreshold: 0.9\n')
    const engine = new TestEngine(ctx, { apiKey: undefined })
    await vi.waitFor(() => {
      expect(engine.fast.keepThreshold).toBe(0.9)
    })
    expect(engine.fast.apiKey).toBe('tsk-env')
  })

  it('publishes provider writes live to every live engine', async () => {
    const ctx = await boot('')
    const owner = new TestEngine(ctx, {})
    // Each engine provides ctx.compaction, so siblings need an isolated
    // service scope (mirroring the preset's compaction realm); the settings
    // service still resolves against the shared parent scope.
    const sibling = new TestEngine(ctx.isolate('compaction'), { keepThreshold: 0.6 })
    await vi.waitFor(() => {
      expect(ctx.settings.describe().some(d => d.ns === 'fast-compaction')).toBe(true)
    })
    expect(owner.fast.keepThreshold).toBe(0.5)
    expect(sibling.fast.keepThreshold).toBe(0.6)
    await ctx.settings.update('fast-compaction', { keepThreshold: 0.7 })
    await vi.waitFor(() => {
      expect(owner.fast.keepThreshold).toBe(0.7)
      expect(sibling.fast.keepThreshold).toBe(0.7)
    })
  })

  it('lets a later engine read the layer its sibling already mirrors', async () => {
    const ctx = await boot('fast-compaction:\n  minReduction: 0.4\n')
    const first = new TestEngine(ctx, {})
    await vi.waitFor(() => {
      expect(first.fast.minReduction).toBe(0.4)
    })
    const second = new TestEngine(ctx.isolate('compaction'), { minReduction: 0.1 })
    // The sibling merges the mirrored layer at construction, registration or not.
    await vi.waitFor(() => {
      expect(second.fast.minReduction).toBe(0.4)
    })
  })

  it('redacts the apiKey from the described wire view', async () => {
    const ctx = await boot('fast-compaction:\n  apiKey: tsk-secret\n')
    const engine = new TestEngine(ctx, {})
    await vi.waitFor(() => {
      expect(ctx.settings.describe().some(d => d.ns === 'fast-compaction')).toBe(true)
    })
    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(d => d.ns === 'fast-compaction')!
    expect(JSON.stringify(descriptor.value)).not.toContain('tsk-secret')
    expect(descriptor.secrets).toEqual([{ path: ['apiKey'], set: true }])
  })
})
