import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { collectToolCalls, orphanResultIndexes } from '../src/pairing.ts'
import { fitState, goalFromMessages, isPinned } from '../src/state.ts'

function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
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
    source: { provider: 'test', model: 'test-model' },
  })
}

function result(id: string, text: string, isError = false) {
  return createToolResultMessage({
    callId: ToolCallId(id),
    content: [{ type: 'text', text }],
    isError,
  })
}

function transcript() {
  return [
    createSystemMessage('system prompt', 'test'),
    user('Fix the failing test.'),
    assistant('Reading the file.', [
      { id: 'a', name: 'read', args: '{"path":"src/a.ts"}' },
    ]),
    result('a', 'x'.repeat(800)),
    user('Also check the build.'),
    assistant('Running the build.', [
      { id: 'b', name: 'bash', args: '{"command":"pnpm build"}' },
      { id: 'c', name: 'bash', args: '{"command":"ls"}' },
    ]),
    result('b', 'build ok'),
    result('c', 'file list'),
    user('Thanks.'),
  ]
}

describe('collectToolCalls', () => {
  it('pairs calls with results by call id and honors pins', () => {
    const messages = transcript()
    // Pin the system head (0) and the message holding call b's result (6).
    const pinned = new Set<number>([0, 6])
    const calls = collectToolCalls(messages, pinned)
    expect(calls.map(call => call.name)).toEqual(['read', 'bash', 'bash'])
    expect(calls[0]!.result?.chars).toBe(800)
    expect(calls[0]!.messageIndex).toBe(2)
    expect(calls[0]!.result?.messageIndex).toBe(3)
    // call b's result message is pinned → the call is pinned
    expect(calls.find(call => call.name === 'bash' && call.arguments.includes('build'))?.pinned).toBe(true)
    // call c is neither pinned by message nor by result
    expect(calls.find(call => call.arguments.includes('ls'))?.pinned).toBe(false)
  })

  it('pins calls whose result is missing', () => {
    const messages = [
      user('hi'),
      assistant('', [{ id: 'x', name: 'bash', args: '{}' }]),
    ]
    const calls = collectToolCalls(messages, new Set())
    expect(calls[0]!.pinned).toBe(true)
    expect(calls[0]!.result).toBeUndefined()
  })

  it('reports orphan results', () => {
    const messages = [user('hi'), result('ghost', 'orphan')]
    expect(orphanResultIndexes(messages, [])).toEqual([1])
  })
})

describe('isPinned', () => {
  it('pins the first message and the newest tail', () => {
    expect(isPinned(0, 10, false, 6)).toBe(true)
    expect(isPinned(1, 10, false, 6)).toBe(false)
    expect(isPinned(4, 10, false, 6)).toBe(true)
    expect(isPinned(5, 10, false, 6)).toBe(true)
  })

  it('pins the first conversational message after a system head', () => {
    expect(isPinned(1, 10, true, 2)).toBe(true)
    expect(isPinned(2, 10, true, 2)).toBe(false)
  })
})

describe('goalFromMessages', () => {
  it('quotes the last three human prompts', () => {
    const messages = [
      user('first prompt'),
      user('second prompt'),
      result('r', 'noise'),
      user('third prompt'),
      user('fourth prompt'),
    ]
    expect(goalFromMessages(messages)).toBe('second prompt\nthird prompt\nfourth prompt')
  })
})

describe('fitState', () => {
  it('builds the full state with results noted and the system head skipped', () => {
    const messages = transcript()
    const calls = collectToolCalls(messages, new Set([0]))
    const fitted = fitState(messages, calls, {
      maxStateTokens: 25_000,
      preserveRecentMessages: 2,
      goal: '',
    })
    expect(fitted.stage).toBe('full')
    expect(fitted.state.context).toContain('coding assistant conversation')
    expect(fitted.state.goal).toContain('Fix the failing test.')
    expect(fitted.state.history[0]!.i).toBe(1)
    expect(fitted.state.history[0]!.role).toBe('user')
    const callEntry = fitted.state.history.find(entry => entry.tool_calls !== undefined)
    expect(callEntry!.tool_calls).toEqual([
      { id: 't1', tool: 'read', input: '{"path":"src/a.ts"}', result: 'ok, 800 chars (omitted)' },
    ])
  })

  it('degrades inputs before texts', () => {
    const messages = [
      user('task'),
      assistant('', [
        { id: 'a', name: 'write', args: 'x'.repeat(400) },
      ]),
      result('a', 'y'.repeat(100)),
    ]
    const calls = collectToolCalls(messages, new Set([0]))
    const roomy = fitState(messages, calls, { maxStateTokens: 25_000, preserveRecentMessages: 2, goal: '' })
    const tight = fitState(messages, calls, { maxStateTokens: 250, preserveRecentMessages: 2, goal: '' })
    expect(roomy.stage).toBe('full')
    expect(tight.stage).not.toBe('full')
    expect(tight.tokens).toBeLessThanOrEqual(250)
  })

  it('throws when nothing fits', () => {
    const messages = [
      user('task'),
      assistant('', [{ id: 'a', name: 'write', args: 'x'.repeat(400) }]),
      result('a', 'y'.repeat(100)),
    ]
    const calls = collectToolCalls(messages, new Set([0]))
    expect(() => fitState(messages, calls, { maxStateTokens: 1, preserveRecentMessages: 2, goal: '' }))
      .toThrow(/too large for Jev/)
  })
})
