import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FastCompactionEngine } from '../src/index.ts'
import type { FastCompactionConfig } from '../src/index.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev.ts'

/** A deterministic Jev double answering every question with one probability. */
class FakeAsker implements JevAsker {
  readonly asked: Array<{ state: JevState; questions: JevQuestions }> = []

  constructor(
    private readonly probability: (name: string) => number,
    private readonly missingAnswers = false,
  ) {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.asked.push({ state, questions })
    const answers: Record<string, { type: 'noul'; noul: number }> = {}
    if (!this.missingAnswers) {
      for (const name of Object.keys(questions)) {
        answers[name] = { type: 'noul', noul: this.probability(name) }
      }
    }
    return { model: 'jev-latest', answers, usage: { input_tokens: 11, output_tokens: 3 } }
  }
}

/** Exposes the protected hook and injects the fake asker. */
class TestEngine extends FastCompactionEngine {
  static asker: FakeAsker

  constructor(ctx: Context, config: FastCompactionConfig & Partial<BasicCompactionConfig> = {}) {
    super(ctx, { apiKey: 'tsk-test', ...config })
  }

  protected override createJevAsker(): JevAsker {
    return TestEngine.asker
  }

  run(input: { messages: readonly Message[] }, agent: Agent): Promise<SummaryResult> {
    return this.summarize({ messages: input.messages }, agent)
  }
}

/** The adapter backing the built-in fallback summarizer. */
class FallbackAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'fallback summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['fake'], new FallbackAdapter())
  return ctx
}

const agent = {
  session: { requestHeader: () => undefined, id: 'test-session' },
  options: { provider: 'fake', model: 'fake-model' },
} as unknown as Agent

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string, calls: Array<{ id: string; name: string; args: string }> = []) {
  return createAssistantMessage({
    content: [
      ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
      ...calls.map(call => ({
        type: 'tool-call' as const,
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.args,
      })),
    ],
    source: { provider: 'fake', model: 'fake-model' },
  })
}

function result(id: string, text: string) {
  return createToolResultMessage({
    callId: ToolCallId(id),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

/** A region whose three calls hold most of the characters. */
function region(): Message[] {
  return [
    createSystemMessage('system prompt', 'test'),
    user('Fix the failing test. Never edit src/generated.'),
    assistant('Reading the file.', [{ id: 'a', name: 'read', args: '{"path":"src/a.ts"}' }]),
    result('a', 'x'.repeat(800)),
    assistant('Checking the build.', [
      { id: 'b', name: 'bash', args: '{"command":"pnpm build"}' },
      { id: 'c', name: 'bash', args: '{"command":"ls -la"}' },
    ]),
    result('b', 'y'.repeat(600)),
    result('c', 'z'.repeat(600)),
    user('Thanks, that is all I needed.'),
  ]
}

describe('FastCompactionEngine.summarize', () => {
  // The region has nine messages; preserving six would pin every call, so
  // these tests preserve only the newest message.
  const TEST_CONFIG = { preserveRecentMessages: 1 }

  it('returns the verbatim-kept transcript from Jev verdicts', async () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(() => 0.05)
    const engine = new TestEngine(ctx, TEST_CONFIG)
    const summary = await engine.run({ messages: region() }, agent)

    expect(summary.provider).toBe('typesafe')
    expect(summary.model).toBe('jev-latest')
    expect(summary.llmStreamCall).toBeUndefined()
    expect(summary.usage).toEqual({ inputTokens: 11, outputTokens: 3 })
    const text = summary.summary.map(block => (block as { text: string }).text).join('\n')
    expect(text).toContain('<user>Fix the failing test. Never edit src/generated.</user>')
    expect(text).toContain('<user>Thanks, that is all I needed.</user>')
    expect(text).not.toContain('x'.repeat(100))
    expect(text).not.toContain('pnpm build')
    // The raw output records the decisions for the durable log: a readable
    // report block for the GUI Raw Output tab, then the machine-readable JSON.
    const blocks = (summary.rawOutput ?? []) as Array<{ type: string; text: string }>
    expect(blocks[0]?.text).toContain('fast-compaction-dsh verdict report')
    expect(blocks[0]?.text).toContain('drop call')
    const raw = blocks
      .map(block => {
        try {
          return JSON.parse(block.text) as { decisions?: Array<{ action: string; reason: string }> }
        } catch {
          return undefined
        }
      })
      .find(parsed => Array.isArray(parsed?.decisions))
    expect(raw?.decisions?.every(decision => decision.action === 'drop_call')).toBe(true)
  })

  it('keeps scored calls verbatim while dropping stale ones', async () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(name => (name === 'call_t1' || name === 'result_t1' ? 0.9 : 0.05))
    const engine = new TestEngine(ctx, TEST_CONFIG)
    const summary = await engine.run({ messages: region() }, agent)

    expect(summary.provider).toBe('typesafe')
    const text = summary.summary.map(block => (block as { text: string }).text).join('\n')
    // The kept result stays verbatim.
    expect(text).toContain('x'.repeat(100))
    expect(text).toContain('<tool-call id="t1" name="read">')
    // The stale calls disappear.
    expect(text).not.toContain('pnpm build')
    expect(text).not.toContain('ls -la')
  })

  it('falls back to the built-in summarizer when reduction is insufficient', async () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(() => 0.99)
    const engine = new TestEngine(ctx, TEST_CONFIG)
    const summary = await engine.run({ messages: region() }, agent)

    expect(summary.provider).toBe('fake')
    expect(summary.model).toBe('fake-model')
    expect(summary.llmStreamCall).toBe(true)
    const text = summary.summary.map(block => (block as { text: string }).text).join('')
    expect(text).toContain('fallback summary')
  })

  it('falls back without asking when no calls are candidates', async () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(() => 0.05)
    const engine = new TestEngine(ctx, TEST_CONFIG)
    const messages = [
      createSystemMessage('system prompt', 'test'),
      user('just text'),
      assistant('just a reply'),
    ]
    const summary = await engine.run({ messages }, agent)
    expect(summary.llmStreamCall).toBe(true)
    expect(summary.summary.map(block => (block as { text: string }).text).join('')).toContain('fallback summary')
  })

  it('falls back without asking when disabled', async () => {
    const ctx = createContext()
    const asker = new FakeAsker(() => 0.05)
    TestEngine.asker = asker
    const engine = new TestEngine(ctx, { ...TEST_CONFIG, disabled: true })
    const summary = await engine.run({ messages: region() }, agent)
    expect(asker.asked.length).toBe(0)
    expect(summary.llmStreamCall).toBe(true)
  })

  it('falls back when Jev answers are invalid', async () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(() => 0.05, true)
    const engine = new TestEngine(ctx, TEST_CONFIG)
    const summary = await engine.run({ messages: region() }, agent)
    expect(summary.llmStreamCall).toBe(true)
  })

  it('passes basic configuration through to the shipped engine', () => {
    const ctx = createContext()
    TestEngine.asker = new FakeAsker(() => 0.05)
    const engine = new TestEngine(ctx, { ...TEST_CONFIG, thresholdRatio: 0.6, keepThreshold: 0.7 })
    expect(engine.config.thresholdRatio).toBe(0.6)
    expect(engine.fast.keepThreshold).toBe(0.7)
  })
})
