/**
 * Decision application and transcript rebuild, ported from
 * fast-jev-compaction's `decideCall`/`applyDecisions`, adapted to the DSH
 * compaction seam: where fast-jev rebuilds a Claude Code message list, DSH
 * replaces the shadowed surface span with ONE user message, so the kept
 * content is rendered as a verbatim transcript — user and assistant text
 * verbatim and in order, kept calls with their inputs, kept results with
 * their text, truncated results as a bounded head plus note.
 *
 * @module fast-compaction-dsh/rebuild
 */

import type { ContentBlock, Message, TextBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallRef } from './pairing.ts'
import { textOf } from './pairing.ts'

/** The action taken for one call. */
export type CallAction = 'keep' | 'drop_result' | 'drop_call'

/** The decision for one call, with the probabilities that produced it. */
export interface CallDecision {
  readonly id: string
  readonly tool: string
  readonly keepCall: number
  readonly keepResult: number
  readonly action: CallAction
  readonly reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped'
}

/** Options of the rebuild. */
export interface RebuildOptions {
  /** Minimum keep probability for a call or result to stay. */
  readonly keepThreshold: number
  /** Characters of a dropped tool result retained before its note. */
  readonly truncateHeadChars: number
}

/**
 * Decide the action for one call from its answers, ported verbatim from
 * fast-jev's `decideCall`.
 *
 * @param call - the call being decided.
 * @param answer - the keep probabilities for the call and its result.
 * @param options - rebuild options.
 * @returns the decision.
 */
export function decideCall(
  call: Pick<ToolCallRef, 'index' | 'name' | 'pinned'>,
  answer: { keepCall: number; keepResult: number },
  options: Pick<RebuildOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: `t${call.index}`, tool: call.name, ...answer }
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' }
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' }
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' }
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' }
}

/** The truncated form of a dropped result, ported from fast-jev. */
function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ''
  return `${head}[fast-compaction-dsh truncated ${text.length - headChars} chars of this tool result${isError ? ' (error)' : ''}; re-run the tool if needed]`
}

/** The action of one call id (`tN`) during a rebuild. */
type ActionMap = Map<string, CallAction>

/** Aggregate outcome of one rebuild. */
export interface RebuildResult {
  /** The transcript content blocks of the replacement user message. */
  readonly blocks: TextBlock[]
  /** Per-call decisions, in call order. */
  readonly decisions: readonly CallDecision[]
  readonly stats: {
    readonly messagesBefore: number
    readonly messagesAfter: number
    readonly charsBefore: number
    readonly charsAfter: number
    readonly calls: number
    readonly kept: number
    readonly resultsDropped: number
    readonly callsDropped: number
    readonly pinned: number
  }
}

/** Characters of text, tool input, and tool output one message holds. */
export function messageChars(message: Message): number {
  let total = textOf(message.content).length
  for (const block of message.content) {
    if (block.type === 'tool-call') total += block.arguments.length
    if (block.type === 'tool-result') total += textOf(block.content).length
  }
  return total
}

/** Render one result's non-text blocks as notes. */
function nonTextNotes(blocks: readonly ContentBlock[]): string[] {
  const notes: string[] = []
  for (const block of blocks) {
    if (block.type === 'image') notes.push('[image omitted]')
    if (block.type === 'file') notes.push('[file omitted]')
  }
  return notes
}

/**
 * Rebuild the shadowed region as a verbatim transcript for the replacement
 * user message.
 *
 * @param messages - the shadowed region's messages in surface order.
 * @param calls - the paired calls from `collectToolCalls`.
 * @param decisions - the decisions, in call order.
 * @param options - rebuild options.
 * @returns the transcript blocks, decisions, and stats.
 */
export function applyToTranscript(
  messages: readonly Message[],
  calls: readonly ToolCallRef[],
  decisions: readonly CallDecision[],
  options: RebuildOptions,
): RebuildResult {
  const byId = new Map(calls.map(call => [`t${call.index}`, call]))
  const actions: ActionMap = new Map()
  for (const decision of decisions) {
    if (decision.action !== 'keep') actions.set(decision.id, decision.action)
  }
  const actionOfCall = (call: ToolCallRef): CallAction | undefined => actions.get(`t${call.index}`)

  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0)
  const blocks: TextBlock[] = []
  let messagesAfter = 0

  const emit = (line: string): void => {
    if (line.trim().length === 0) return
    blocks.push({ type: 'text', text: line })
  }

  const callByMessage = new Map<number, ToolCallRef[]>()
  for (const call of calls) {
    const list = callByMessage.get(call.messageIndex) ?? []
    list.push(call)
    callByMessage.set(call.messageIndex, list)
  }
  const resultOwner = new Map<number, ToolCallRef>()
  for (const call of calls) {
    if (call.result !== undefined) resultOwner.set(call.result.messageIndex, call)
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'system') continue
    const lines: string[] = []

    if (message.role === 'assistant') {
      const text = textOf(message.content.filter(block => block.type !== 'reasoning'))
      if (text.trim().length > 0) lines.push(`<assistant>${text}</assistant>`)
      for (const call of callByMessage.get(messageIndex) ?? []) {
        if (actionOfCall(call) === 'drop_call') continue
        lines.push(`<tool-call id="t${call.index}" name="${call.name}">${call.arguments}</tool-call>`)
      }
    } else {
      const ownedCall = resultOwner.get(messageIndex)
      if (ownedCall !== undefined && message.content[0]?.type === 'tool-result') {
        const action = actionOfCall(ownedCall)
        if (action !== 'drop_call' && ownedCall.result !== undefined) {
          const text = textOf(ownedCall.result.content)
          const notes = nonTextNotes(ownedCall.result.content)
          if (action === 'drop_result') {
            lines.push(`<result id="t${ownedCall.index}">${truncatedResultText(text, ownedCall.result.isError, options.truncateHeadChars)}</result>`)
          } else {
            lines.push(`<result id="t${ownedCall.index}">${text}</result>`)
          }
          lines.push(...notes)
        }
      } else {
        const text = textOf(message.content)
        if (text.trim().length > 0) lines.push(`<user>${text}</user>`)
        for (const block of message.content) {
          if (block.type === 'image') lines.push('[image omitted]')
          if (block.type === 'file') lines.push('[file omitted]')
        }
      }
    }

    if (lines.length > 0) {
      messagesAfter += 1
      emit(lines.join('\n'))
    }
  }

  if (blocks.length === 0) {
    emit('[all scored tool activity in this span was stale and has been removed; user and assistant text was empty]')
  }

  const count = (reason: CallDecision['reason']): number => (
    decisions.filter(decision => decision.reason === reason).length
  )
  const charsAfter = blocks.reduce((sum, block) => sum + block.text.length, 0)
  return {
    blocks,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter,
      charsBefore,
      charsAfter,
      calls: calls.length,
      kept: count('kept'),
      resultsDropped: count('result_dropped'),
      callsDropped: count('call_dropped'),
      pinned: count('pinned'),
    },
  }
}

/**
 * The share of the region's characters the rebuild removed.
 * @param stats - the rebuild stats.
 * @returns the reduction ratio in [0, 1).
 */
export function reductionRatio(stats: Pick<RebuildResult['stats'], 'charsBefore' | 'charsAfter'>): number {
  return stats.charsBefore === 0 ? 0 : (stats.charsBefore - stats.charsAfter) / stats.charsBefore
}
