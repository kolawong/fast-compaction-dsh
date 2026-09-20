import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { collectToolCalls } from '../src/pairing.ts'
import { applyToTranscript, decideCall, messageChars, reductionRatio } from '../src/rebuild.ts'
import type { CallDecision } from '../src/rebuild.ts'

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

function region(): Message[] {
  return [
    createSystemMessage('system prompt', 'test'),
    user('Fix the failing test. Never edit src/generated.'),
    assistant('Reading the file.', [{ id: 'a', name: 'read', args: '{"path":"src/a.ts"}' }]),
    result('a', 'line1\nline2\n' + 'x'.repeat(900)),
    assistant('Checking the build.', [
      { id: 'b', name: 'bash', args: '{"command":"pnpm build"}' },
      { id: 'c', name: 'bash', args: '{"command":"ls -la"}' },
    ]),
    result('b', 'built in 3s'),
    result('c', 'total 0'),
    user('Thanks, that is all I needed.'),
  ]
}

describe('decideCall', () => {
  const options = { keepThreshold: 0.5 }

  it('keeps a call whose result scores high', () => {
    const decision = decideCall({ index: 1, name: 'bash', pinned: false }, { keepCall: 0.9, keepResult: 0.8 }, options)
    expect(decision).toMatchObject({ action: 'keep', reason: 'kept' })
  })

  it('truncates the result when only the call scores high', () => {
    const decision = decideCall({ index: 1, name: 'bash', pinned: false }, { keepCall: 0.9, keepResult: 0.1 }, options)
    expect(decision).toMatchObject({ action: 'drop_result', reason: 'result_dropped' })
  })

  it('drops both when neither scores high', () => {
    const decision = decideCall({ index: 1, name: 'bash', pinned: false }, { keepCall: 0.2, keepResult: 0.1 }, options)
    expect(decision).toMatchObject({ action: 'drop_call', reason: 'call_dropped' })
  })

  it('never touches pinned calls', () => {
    const decision = decideCall({ index: 1, name: 'bash', pinned: true }, { keepCall: 0.0, keepResult: 0.0 }, options)
    expect(decision).toMatchObject({ action: 'keep', reason: 'pinned' })
  })
})

describe('applyToTranscript', () => {
  const options = { keepThreshold: 0.5, truncateHeadChars: 300 }

  it('keeps text verbatim and applies per-call decisions', () => {
    const messages = region()
    const calls = collectToolCalls(messages, new Set([0]))
    const decisions: CallDecision[] = [
      { id: 't1', tool: 'read', keepCall: 0.9, keepResult: 0.1, action: 'drop_result', reason: 'result_dropped' },
      { id: 't2', tool: 'bash', keepCall: 0.9, keepResult: 0.9, action: 'keep', reason: 'kept' },
      { id: 't3', tool: 'bash', keepCall: 0.1, keepResult: 0.1, action: 'drop_call', reason: 'call_dropped' },
    ]
    const rebuilt = applyToTranscript(messages, calls, decisions, options)

    const text = rebuilt.blocks.map(block => block.text).join('\n')
    // User text stays verbatim, in order, with role labels.
    expect(text).toContain('<user>Fix the failing test. Never edit src/generated.</user>')
    expect(text).toContain('<user>Thanks, that is all I needed.</user>')
    // The truncated result keeps a head and a note (908 chars − 300 head = 608).
    expect(text).toContain('<result id="t1">line1\nline2\n')
    expect(text).toContain('[fast-compaction-dsh truncated 612 chars of this tool result')
    expect(text).toContain('re-run the tool if needed]')
    // The kept short result stays verbatim.
    expect(text).toContain('<result id="t2">built in 3s</result>')
    // The dropped call and result disappear entirely.
    expect(text).not.toContain('ls -la')
    expect(text).not.toContain('total 0')
    // The system head never enters the transcript.
    expect(text).not.toContain('system prompt')

    expect(rebuilt.stats.calls).toBe(3)
    expect(rebuilt.stats.kept).toBe(1)
    expect(rebuilt.stats.resultsDropped).toBe(1)
    expect(rebuilt.stats.callsDropped).toBe(1)
    expect(reductionRatio(rebuilt.stats)).toBeGreaterThan(0)
  })

  it('reports the character reduction', () => {
    const messages = region()
    const calls = collectToolCalls(messages, new Set([0]))
    const decisions = calls.map(call => ({
      id: `t${call.index}`,
      tool: call.name,
      keepCall: 0,
      keepResult: 0,
      action: 'drop_call' as const,
      reason: 'call_dropped' as const,
    }))
    const rebuilt = applyToTranscript(messages, calls, decisions, options)
    expect(rebuilt.stats.charsAfter).toBeLessThan(rebuilt.stats.charsBefore)
    expect(reductionRatio(rebuilt.stats)).toBeGreaterThan(0.25)
    // Texts survive even when every call is dropped.
    const text = rebuilt.blocks.map(block => block.text).join('\n')
    expect(text).toContain('<user>Fix the failing test. Never edit src/generated.</user>')
  })

  it('emits a placeholder when everything is dropped', () => {
    const messages = [
      createSystemMessage('s', 'test'),
      assistant('', [{ id: 'a', name: 'bash', args: '{}' }]),
      result('a', 'out'),
    ]
    const calls = collectToolCalls(messages, new Set())
    const decisions = calls.map(call => ({
      id: `t${call.index}`,
      tool: call.name,
      keepCall: 0,
      keepResult: 0,
      action: 'drop_call' as const,
      reason: 'call_dropped' as const,
    }))
    const rebuilt = applyToTranscript(messages, calls, decisions, options)
    expect(rebuilt.blocks.length).toBeGreaterThan(0)
    expect(rebuilt.blocks[0]!.text).toContain('stale')
  })
})

describe('messageChars', () => {
  it('counts text, arguments, and result text', () => {
    const message = result('a', '12345')
    expect(messageChars(message)).toBe(5)
  })
})
