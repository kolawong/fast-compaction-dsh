/**
 * Fast verdict-based compaction engine for DeepSeek Harness, ported from
 * tamaratran/fast-jev-compaction.
 *
 * Where the shipped `compaction-basic` backend replaces the compacted span
 * with a lossy LLM summary, this engine keeps everything verbatim and only
 * removes what the `jev-latest` model says is stale: every tool call and
 * result in the compacted region is scored through TypeSafe's System One
 * endpoint (two `noul` questions per call), stale calls are deleted,
 * half-stale results are truncated to a bounded head, and everything kept
 * stays verbatim. User and assistant text is never removed.
 *
 * On any failure — a missing `TYPESAFE_API_KEY`, a Jev error, malformed
 * answers, an unfittable history, or an insufficient reduction — it falls
 * back to the built-in `compaction-basic` summarizer, exactly like the
 * Claude Code hook falls back to Claude Code's built-in summary.
 *
 * The engine subclasses `BasicCompactionEngine` and overrides its sole
 * customization hook `summarize()`: retention, region selection, the durable
 * compaction transaction (lock, events, stability checks, shrink validation,
 * checkpoint framing) stay owned by the shipped machinery.
 *
 * @module fast-compaction-dsh
 */

import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TextBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { JevClient, SYSTEM_ONE_URL, DEFAULT_MODEL, noulAnswer, questionsFor } from './jev.ts'
import type { JevAsker, JevQuestions, JevState } from './jev.ts'
import { estimateTokens } from './estimate.ts'
import { collectToolCalls } from './pairing.ts'
import type { ToolCallRef } from './pairing.ts'
import { fitState, hasSystemHead, isPinned } from './state.ts'
import { applyToTranscript, decideCall, reductionRatio } from './rebuild.ts'
import type { CallDecision } from './rebuild.ts'

export { JevClient, SYSTEM_ONE_URL, DEFAULT_MODEL, buildJevRequest, parseJevResponse, noulAnswer, questionsFor } from './jev.ts'
export type { JevAsker, JevClientOptions, JevQuestions, JevRequest, JevResponse, JevState, NoulAnswer, NoulQuestion } from './jev.ts'
export { collectToolCalls, orphanResultIndexes, textOf } from './pairing.ts'
export type { PairedResult, ToolCallRef } from './pairing.ts'
export { fitState, goalFromMessages, isPinned, STATE_CONTEXT } from './state.ts'
export type { CompactionState, FittedState, HistoryEntry, HistoryToolCall, StateOptions } from './state.ts'
export { applyToTranscript, decideCall, messageChars, reductionRatio } from './rebuild.ts'
export type { CallAction, CallDecision, RebuildOptions, RebuildResult } from './rebuild.ts'
export { estimateTokens, truncateText } from './estimate.ts'

/** Plugin configuration: the fast-jev layer on top of `BasicCompactionConfig`. */
export interface FastCompactionConfig {
  /** Disable the verdict path and use only the built-in summarizer (default false). */
  readonly disabled?: boolean
  /** TypeSafe API key; defaults to `process.env.TYPESAFE_API_KEY`. */
  readonly apiKey?: string
  /** Jev model name (default `jev-latest`). */
  readonly model?: string
  /** System One endpoint (default `https://api.typesafe.ai/v1/systemone`). */
  readonly baseUrl?: string
  /** Minimum keep probability for a call or result to stay (default 0.5). */
  readonly keepThreshold?: number
  /** Newest messages never touched (the first is always kept; default 6). */
  readonly preserveRecentMessages?: number
  /** Estimated token ceiling for the state (default 25000). */
  readonly maxStateTokens?: number
  /** Estimated ceiling for state plus one batch of questions (default 30000). */
  readonly maxRequestTokens?: number
  /** Characters of a dropped tool result retained before its note (default 300). */
  readonly truncateHeadChars?: number
  /** Fall back to the built-in summary below this reduction ratio (default 0.25). */
  readonly minReduction?: number
}

/** Every key this plugin owns; the rest passes through to `BasicCompactionConfig`. */
const FAST_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'disabled',
  'apiKey',
  'model',
  'baseUrl',
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
  'minReduction',
])

/** Resolved plugin defaults, ported from fast-jev-compaction. */
export interface ResolvedFastConfig {
  readonly disabled: boolean
  readonly apiKey: string
  readonly model: string
  readonly baseUrl: string
  readonly keepThreshold: number
  readonly preserveRecentMessages: number
  readonly maxStateTokens: number
  readonly maxRequestTokens: number
  readonly truncateHeadChars: number
  readonly minReduction: number
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Resolve the fast layer's defaults from raw configuration. */
export function resolveFastConfig(config: FastCompactionConfig): ResolvedFastConfig {
  return {
    disabled: config.disabled === true,
    apiKey: config.apiKey ?? process.env.TYPESAFE_API_KEY ?? '',
    model: config.model !== undefined && config.model.length > 0 ? config.model : DEFAULT_MODEL,
    baseUrl: config.baseUrl !== undefined && config.baseUrl.length > 0 ? config.baseUrl : SYSTEM_ONE_URL,
    keepThreshold: finite(config.keepThreshold, 0.5),
    preserveRecentMessages: Math.max(0, Math.floor(finite(config.preserveRecentMessages, 6))),
    maxStateTokens: Math.max(1, finite(config.maxStateTokens, 25_000)),
    maxRequestTokens: Math.max(1, finite(config.maxRequestTokens, 30_000)),
    truncateHeadChars: Math.max(0, Math.floor(finite(config.truncateHeadChars, 300))),
    minReduction: finite(config.minReduction, 0.25),
  }
}

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20

/**
 * Split the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request, ported from fast-jev's
 * `batchCalls`.
 *
 * @param calls - the unpinned candidate calls.
 * @param stateTokens - estimated tokens of the fitted state.
 * @param options - the request budget.
 * @returns the batches, one per Jev request.
 */
export function batchCalls(
  calls: readonly ToolCallRef[],
  stateTokens: number,
  options: Pick<ResolvedFastConfig, 'maxRequestTokens'>,
): ToolCallRef[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS
  const batches: ToolCallRef[][] = []
  let current: ToolCallRef[] = []
  let currentTokens = 0
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)))
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      )
    }
    current.push(call)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * The verdict-based compaction engine. Mount it where `compaction-basic`
 * would mount (inside the agent preset's `compaction` isolate realm) as
 * `ctx.compaction`.
 *
 * Configuration is not re-declared as a static schema: the inherited
 * `BasicCompactionEngine.Config` keeps validating the passthrough fields,
 * schemastery preserves this layer's keys untouched, and
 * {@link resolveFastConfig} resolves their defaults in the constructor.
 */
export class FastCompactionEngine extends BasicCompactionEngine {
  /** The resolved fast layer configuration. */
  public readonly fast: ResolvedFastConfig
  private readonly asker: JevAsker

  constructor(ctx: Context, config: FastCompactionConfig & BasicCompactionConfig = {}) {
    const fast: FastCompactionConfig = {}
    const basic: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(config)) {
      if (FAST_CONFIG_KEYS.has(key)) (fast as Record<string, unknown>)[key] = value
      else basic[key] = value
    }
    super(ctx, basic as BasicCompactionConfig)
    this.fast = resolveFastConfig(fast)
    this.asker = this.createJevAsker()
  }

  /** Build the Jev transport; subclasses may inject a test double. */
  protected createJevAsker(): JevAsker {
    return new JevClient({
      apiKey: this.fast.apiKey,
      model: this.fast.model,
      baseUrl: this.fast.baseUrl,
    })
  }

  /**
   * The sole `BasicCompactionEngine` customization hook: replace the lossy
   * summary with the verbatim-kept transcript selected by Jev verdicts, and
   * fall back to the built-in summarizer on any failure or insufficient
   * reduction.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {    if (this.fast.disabled) return super.summarize(input, agent, signal)
    try {
      const verdict = await this.verdictSummarize(input, signal)
      if (verdict !== null) return verdict
      this.ctx.logger.info(
        'fast-compaction-dsh: insufficient reduction; falling back to the built-in summary',
      )
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `fast-compaction-dsh: verdict pass failed (${message}); falling back to the built-in summary`,
      )
    }
    return super.summarize(input, agent, signal)
  }

  /**
   * Run the fast-jev flow over one region: pair calls, fit the state, ask
   * Jev in concurrent batches, apply the decisions, and rebuild the region
   * as a verbatim transcript.
   *
   * @param input - the replayed conversation prefix to condense.
   * @param signal - optional cancellation forwarded to the transport.
   * @returns the summary result for the kept transcript, or `null` when the
   * verdict path cannot apply (no candidates, no key, or insufficient
   * reduction).
   */
  private async verdictSummarize(
    input: SummarizationInput,
    signal?: AbortSignal,
  ): Promise<SummaryResult | null> {
    if (this.fast.apiKey.length === 0) {
      this.ctx.logger.warn(
        'fast-compaction-dsh: TYPESAFE_API_KEY is not configured; the verdict pass is skipped',
      )
      return null
    }

    const messages = input.messages
    const systemHead = hasSystemHead(messages)
    const pinned = new Set<number>()
    for (const [index] of messages.entries()) {
      if (isPinned(index, messages.length, systemHead, this.fast.preserveRecentMessages)) {
        pinned.add(index)
      }
    }
    const calls = collectToolCalls(messages, pinned)
    const candidates = calls.filter(call => !call.pinned && call.result !== undefined)
    if (candidates.length === 0) return null

    const fitted = fitState(messages, calls, {
      maxStateTokens: this.fast.maxStateTokens,
      preserveRecentMessages: this.fast.preserveRecentMessages,
      goal: '',
    })
    const batches = batchCalls(candidates, fitted.tokens, this.fast)
    const batchesAnswered = await Promise.all(
      batches.map(batch => this.askBatch(fitted.state, batch, signal)),
    )
    const answers = new Map<string, { keepCall: number; keepResult: number }>()
    let inputTokens = 0
    let outputTokens = 0
    for (const { answered, usage } of batchesAnswered) {
      for (const [id, answer] of answered) answers.set(id, answer)
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
    }

    const decisions: CallDecision[] = calls.map(call => decideCall(
      call,
      answers.get(`t${call.index}`) ?? { keepCall: 1, keepResult: 1 },
      this.fast,
    ))
    const rebuilt = applyToTranscript(messages, calls, decisions, this.fast)
    if (reductionRatio(rebuilt.stats) < this.fast.minReduction) return null

    const { stats } = rebuilt
    this.ctx.logger.info(
      `fast-compaction-dsh: kept ${stats.kept + stats.pinned}/${stats.calls} calls verbatim `
      + `(${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped), `
      + `${stats.charsBefore} → ${stats.charsAfter} chars, state ~${fitted.tokens} tokens `
      + `(${fitted.stage}), ${batches.length} Jev request${batches.length === 1 ? '' : 's'}`,
    )

    const rawOutput: ContentBlock[] = [{
      type: 'text',
      text: JSON.stringify({ decisions, stats, stateStage: fitted.stage }, null, 2),
    }]
    const usage: TokenUsage | undefined = inputTokens + outputTokens > 0
      ? { inputTokens: inputTokens, outputTokens: outputTokens }
      : undefined
    return {
      summary: rebuilt.blocks as TextBlock[],
      provider: 'typesafe',
      model: this.fast.model,
      rawOutput,
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * Ask one batch of questions against the fitted state and merge its
   * answers; a missing answer for a call keeps that call (fail-safe).
   */
  private async askBatch(
    state: JevState,
    batch: readonly ToolCallRef[],
    signal?: AbortSignal,
  ): Promise<{ answered: Map<string, { keepCall: number; keepResult: number }>; usage: { inputTokens: number; outputTokens: number } }> {
    const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor))
    const response = await this.asker.ask(state, questions, signal)
    const answered = new Map<string, { keepCall: number; keepResult: number }>(
      batch.map(call => [
        `t${call.index}`,
        {
          keepCall: noulAnswer(response.answers, `call_t${call.index}`),
          keepResult: noulAnswer(response.answers, `result_t${call.index}`),
        },
      ]),
    )
    return {
      answered,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    }
  }
}

export default FastCompactionEngine
