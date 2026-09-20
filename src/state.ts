/**
 * The fitted Jev state, ported from fast-jev-compaction's `state.ts`: the
 * whole conversation, oldest first, with every tool result replaced by a
 * short note and long texts abridged only when the token budget forces it.
 *
 * The shape is the fast-jev `CompactionState` wire object (`context`, `goal`,
 * `history`), so the `jev-latest` model sees exactly the structure it was
 * calibrated against.
 *
 * @module fast-compaction-dsh/state
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { estimateTokens, truncateText } from './estimate.ts'
import type { ToolCallRef } from './pairing.ts'
import { textOf } from './pairing.ts'

/** One structured call inside a history entry. */
export interface HistoryToolCall {
  readonly id: string
  readonly tool: string
  readonly input: string
  readonly result: string
}

/** One history entry (a message, calls attached). */
export interface HistoryEntry {
  i: number
  role: 'user' | 'assistant'
  text: string
  /** Structured per call, or one compact line per call once the state shrinks. */
  tool_calls?: HistoryToolCall[] | string[]
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  readonly context: string
  readonly goal: string
  readonly history: HistoryEntry[]
}

/** A fitted state with its estimated token size and fitting stage. */
export interface FittedState {
  readonly state: CompactionState
  readonly tokens: number
  readonly stage: string
}

/** Options controlling state fitting. */
export interface StateOptions {
  readonly maxStateTokens: number
  readonly preserveRecentMessages: number
  readonly goal: string
}

/** The context note sent as part of every state, ported verbatim. */
export const STATE_CONTEXT = 'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.'

/** Successive caps on the serialized tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const
/** Abridged-text head and tail budgets. */
const TEXT_HEAD = 400
const TEXT_TAIL = 150

/**
 * Whether a message index is pinned: the first message, or one of the newest
 * `preserveRecentMessages` messages. A leading system head shifts the first
 * conversational message to index 1, which is pinned with it.
 * @param index - message index.
 * @param total - total messages.
 * @param systemHead - whether messages[0] is a system-role head.
 * @param preserveRecentMessages - newest messages never touched.
 * @returns whether the index is pinned.
 */
export function isPinned(index: number, total: number, systemHead: boolean, preserveRecentMessages: number): boolean {
  return index === 0 || (systemHead && index === 1) || index >= total - preserveRecentMessages
}

/**
 * Drop the leading system message from the region — it stays at surface
 * node 0 and is never shadowed, so neither the state nor the rebuilt
 * transcript may include it.
 * @param messages - region messages.
 * @returns whether messages[0] is a system-role head.
 */
export function hasSystemHead(messages: readonly Message[]): boolean {
  return messages[0]?.role === 'system'
}

/** The result note of one call, ported verbatim. */
function resultNote(call: ToolCallRef): string {
  const chars = call.result === undefined
    ? 0
    : textOf(call.result.content).length
  return `${call.result?.isError === true ? 'error' : 'ok'}, ${chars} chars (omitted)`
}

/** The raw arguments of a DSH tool call, truncated to a cap. */
function inputText(call: ToolCallRef, limit: number): string {
  return truncateText(call.arguments, limit)
}

/**
 * One call as a single line, for when the structured form is too costly.
 * Ported from fast-jev's `compactCall`.
 */
function compactCall(call: ToolCallRef): string {
  let input: string
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    input = typeof parsed === 'object' && parsed !== null
      ? Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => {
          const text = typeof value === 'string' ? value : truncateText(JSON.stringify({ [key]: value }), 200)
          return `${key}=${text.replace(/\s+/g, ' ')}`
        })
        .join(' ')
      : truncateText(call.arguments, INPUT_CHARS[2])
  } catch {
    input = truncateText(call.arguments, INPUT_CHARS[2])
  }
  const chars = call.result === undefined ? 0 : textOf(call.result.content).length
  return `${call.index} ${call.name} ${truncateText(input, INPUT_CHARS[2])} → ${call.result?.isError === true ? 'error' : 'ok'} ${chars}ch`
}

/** Calls grouped by their owning message index. */
function callsByMessage(calls: readonly ToolCallRef[]): Map<number, ToolCallRef[]> {
  const byMessage = new Map<number, ToolCallRef[]>()
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? []
    list.push(call)
    byMessage.set(call.messageIndex, list)
  }
  return byMessage
}

/** Build the history entries at one input truncation cap. */
function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCallRef[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls)
  const entries: HistoryEntry[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') continue
    const toolCalls = (byMessage.get(index) ?? []).map(call => ({
      id: `t${call.index}`,
      tool: call.name,
      input: inputText(call, inputChars),
      result: resultNote(call),
    }))
    const text = message.role === 'assistant'
      ? textOf(message.content.filter(block => block.type !== 'reasoning'))
      : textOf(message.content)
    if (text.trim().length === 0 && toolCalls.length === 0) continue
    const entry: HistoryEntry = { i: index, role: message.role === 'assistant' ? 'assistant' : 'user', text }
    if (toolCalls.length > 0) entry.tool_calls = toolCalls
    entries.push(entry)
  }
  return entries
}

/**
 * The last three human prompts, as the default `goal`, ported verbatim.
 * @param messages - region messages.
 * @returns the joined goal text.
 */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(message => message.role === 'user'
      && message.source.kind === 'user'
      && textOf(message.content).trim().length > 0)
    .slice(-3)
    .map(message => truncateText(textOf(message.content), 500))
    .join('\n')
}

/**
 * Builds the Jev state from the whole region and shrinks it in stages until
 * it fits `maxStateTokens`, ported from fast-jev's `fitState`: tool inputs
 * truncate (1000 → 200 → 60 characters), then long texts abridge oldest-first
 * (pinned messages last), then old messages collapse to a one-line note, then
 * old tool calls shrink to one line each, then old messages that carry no call
 * are left out, then runs of old call-only messages fold into one entry.
 *
 * @param messages - the shadowed region's messages in surface order.
 * @param calls - the paired calls from `collectToolCalls`.
 * @param options - fitting options.
 * @returns the fitted state.
 * @throws when even the final stage cannot fit the budget.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCallRef[],
  options: StateOptions,
): FittedState {
  const systemHead = hasSystemHead(messages)
  const pinnedIndex = (index: number): boolean => (
    isPinned(index, messages.length, systemHead, options.preserveRecentMessages)
  )
  const goal = options.goal.length > 0 ? options.goal : goalFromMessages(messages)
  const stateOf = (history: HistoryEntry[]): CompactionState => ({ context: STATE_CONTEXT, goal, history })
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])))
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  })

  let history: HistoryEntry[] = []
  let perEntry: number[] = []
  let tokens = 0
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars)
    perEntry = history.map(entryTokens)
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  }
  const fits = (): boolean => tokens <= options.maxStateTokens
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index]
    if (entry === undefined) return
    change(entry)
    const now = entryTokens(entry)
    tokens += now - (perEntry[index] ?? 0)
    perEntry[index] = now
  }

  rebuild(INPUT_CHARS[0])
  if (fits()) return fitted(history, tokens, 'full')

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit)
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`)
  }

  const pinned = (entry: HistoryEntry): boolean => pinnedIndex(entry.i)
  const indices = history.map((_, index) => index)
  const order = [
    ...indices.filter(index => !pinned(history[index]!)),
    ...indices.filter(index => pinned(history[index]!)),
  ]

  const abridge = (text: string): string => {
    if (text.length <= TEXT_HEAD + TEXT_TAIL + 40) return text
    const omitted = text.length - TEXT_HEAD - TEXT_TAIL
    return `${text.slice(0, TEXT_HEAD)}\n[… ${omitted} chars omitted …]\n${text.slice(-TEXT_TAIL)}`
  }
  for (const index of order) {
    const entry = history[index]!
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue
    shrink(index, (e) => {
      e.text = abridge(e.text)
    })
    if (fits()) return fitted(history, tokens, 'texts abridged')
  }

  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.text.length === 0) continue
    const original = textOf(messages[entry.i]?.content ?? []).length
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`
    })
    if (fits()) return fitted(history, tokens, 'old messages collapsed')
  }

  const byMessage = callsByMessage(calls)
  for (const index of order) {
    const entry = history[index]!
    const own = byMessage.get(entry.i)
    if (pinned(entry) || own === undefined) continue
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall)
    })
    if (fits()) return fitted(history, tokens, 'old calls compacted')
  }

  const left = new Set<number>()
  for (const index of order) {
    const entry = history[index]!
    if (pinned(entry) || entry.tool_calls !== undefined) continue
    left.add(index)
    tokens -= perEntry[index] ?? 0
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      )
    }
  }
  history = mergeCallRuns(history.filter((_, i) => !left.has(i)), pinned)
  perEntry = history.map(entryTokens)
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
  if (fits()) return fitted(history, tokens, 'old calls merged')

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  )
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(history: readonly HistoryEntry[], pinned: (entry: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = []
  for (const entry of history) {
    const previous = merged[merged.length - 1]
    const foldable = (e: HistoryEntry): boolean => (
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string'
    )
    if (previous !== undefined && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])]
      continue
    }
    merged.push({ ...entry })
  }
  return merged
}
