/**
 * Tool-call/result pairing over a compaction region.
 *
 * Ported from fast-jev-compaction's `collectToolCalls`: every assistant
 * `tool-call` block is paired with the user message carrying its
 * `tool-result`, matched by call id. Calls in pinned messages (the first
 * message and the newest `preserveRecentMessages`) are never scored. Calls
 * whose result cannot be found are pinned defensively.
 *
 * @module fast-compaction-dsh/pairing
 */

import type { ContentBlock, Message, ToolCallId } from '@deepseek-ai/dsh-llm'

/** Structural type of a `tool-result` content block. */
type ToolResultBlock = Extract<ContentBlock, { type: 'tool-result' }>

/** The paired tool-result of one call, when the region contains it. */
export interface PairedResult {
  /** Index in the region message list of the user message carrying the result. */
  readonly messageIndex: number
  /** The tool-result block's payload content. */
  readonly content: readonly ContentBlock[]
  /** Whether the tool reported an error. */
  readonly isError: boolean
  /** Characters of text the result holds. */
  readonly chars: number
}

/** One tool call with its pairing and pin state, in region order. */
export interface ToolCallRef {
  /** Stable 1-based region order (`t1`, `t2`, …) used in the scorer exchange. */
  readonly index: number
  /** Provider-issued call id correlating the call with its result. */
  readonly callId: ToolCallId
  /** Tool name. */
  readonly name: string
  /** Raw JSON arguments string as produced by the model. */
  readonly arguments: string
  /** Index in the region message list of the assistant message owning the call. */
  readonly messageIndex: number
  /** Pinned calls are never scored, pruned, or truncated. */
  readonly pinned: boolean
  /** The paired result message, when present in the region. */
  readonly result?: PairedResult
}

/** Structural guard for a user message carrying exactly one tool result. */
function toolResultOf(message: Message): { toolCallId: ToolCallId; block: ToolResultBlock } | undefined {
  if (message.role !== 'user') return undefined
  const first = message.content[0]
  if (first === undefined || first.type !== 'tool-result') return undefined
  return { toolCallId: first.toolCallId, block: first }
}

/** The text of content blocks, reasoning excluded. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Pair every tool call in the region with its tool result.
 *
 * @param messages - the shadowed region's messages in surface order (the
 * leading system message, when present, is included and simply never holds
 * calls).
 * @param pinnedMessageIndexes - indexes whose calls are pinned.
 * @returns calls in region order.
 */
export function collectToolCalls(
  messages: readonly Message[],
  pinnedMessageIndexes: ReadonlySet<number>,
): ToolCallRef[] {
  const results = new Map<ToolCallId, { messageIndex: number; block: ToolResultBlock }>()
  for (const [messageIndex, message] of messages.entries()) {
    const result = toolResultOf(message)
    if (result !== undefined && !results.has(result.toolCallId)) {
      results.set(result.toolCallId, { messageIndex, block: result.block })
    }
  }

  const calls: ToolCallRef[] = []
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const paired = results.get(block.id)
      // A call is pinned when its message is pinned, when its result message
      // is pinned, or when its result cannot be found (defensive: never
      // prune something we cannot fully reason about). fast-jev skips
      // result-less calls entirely — there is nothing to drop yet.
      const pinned = pinnedMessageIndexes.has(messageIndex)
        || (paired !== undefined && pinnedMessageIndexes.has(paired.messageIndex))
        || paired === undefined
      calls.push({
        index: calls.length + 1,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
        messageIndex,
        pinned,
        ...(paired === undefined ? {} : {
          result: {
            messageIndex: paired.messageIndex,
            content: paired.block.content,
            isError: paired.block.isError === true,
            chars: textOf(paired.block.content).length,
          },
        }),
      })
    }
  }
  return calls
}

/**
 * Indexes of tool-result messages whose call is not in the region.
 *
 * The engine's balanced boundaries keep call/result pairs inside one region,
 * so this is normally empty; a non-empty answer means the transcript is
 * unusual and those results are pinned.
 *
 * @param messages - the region messages.
 * @param calls - the collected calls.
 * @returns orphan result message indexes.
 */
export function orphanResultIndexes(messages: readonly Message[], calls: readonly ToolCallRef[]): number[] {
  const known = new Set(calls.map(call => call.callId))
  const orphans: number[] = []
  for (const [messageIndex, message] of messages.entries()) {
    const result = toolResultOf(message)
    if (result !== undefined && !known.has(result.toolCallId)) orphans.push(messageIndex)
  }
  return orphans
}
