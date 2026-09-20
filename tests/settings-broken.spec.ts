/**
 * The malformed-section and no-provider degradation paths live apart from
 * settings.spec.ts: a rejected stored section flips the process-wide
 * `settingsBroken` latch in src/index.ts, and module state is per test file.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FastCompactionEngine } from '../src/index.ts'
import type { FastCompactionConfig } from '../src/index.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev.ts'

class StubAsker implements JevAsker {
  ask(_state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const answers: Record<string, { type: 'noul'; noul: number }> = {}
    for (const name of Object.keys(questions)) answers[name] = { type: 'noul', noul: 1 }
    return Promise.resolve({ model: 'stub', answers })
  }
}

class TestEngine extends FastCompactionEngine {
  constructor(ctx: Context, config: FastCompactionConfig & Partial<BasicCompactionConfig> = {}) {
    super(ctx, { apiKey: 'tsk-test', ...config })
  }

  protected override createJevAsker(): JevAsker {
    return new StubAsker()
  }
}

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
})

function baseContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['fake'], new StubAdapter())
  return ctx
}

describe('FastCompactionEngine settings degradation', () => {
  it('resolves composition config alone when no settings provider is mounted', () => {
    const ctx = baseContext()
    const engine = new TestEngine(ctx, { keepThreshold: 0.3, model: 'jev-preset' })
    expect(engine.fast.keepThreshold).toBe(0.3)
    expect(engine.fast.model).toBe('jev-preset')
  })

  it('keeps composition values and warns when the stored section fails the schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fast-compaction-broken-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'settings.yaml'), 'fast-compaction:\n  keepThreshold: high\n')
    const ctx = baseContext()
    const fiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    const engine = new TestEngine(ctx, { keepThreshold: 0.3 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(engine.fast.keepThreshold).toBe(0.3)
  })
})
