/**
 * Human-readable verdict report persisted as the first `rawOutput` text block,
 * so the GUI's Trajectory view (compaction cell → 原始输出 / Raw Output tab)
 * and log readers see an aligned table instead of raw JSON. The
 * machine-readable `{decisions, stats, stateStage}` JSON stays as the second
 * block for tooling (`scripts/inspect-compaction.mjs` finds it by parsing).
 *
 * @module fast-compaction-dsh/report
 */

import type { CallDecision, RebuildResult } from './rebuild.ts'

/** Report header inputs beyond the rebuild result itself. */
export interface ReportContext {
  /** Jev state-fitting stage (e.g. `fitted`). */
  readonly stateStage: string
  /** Estimated tokens of the fitted state the questions ran against. */
  readonly stateTokens: number
  /** Jev model that answered the questions. */
  readonly model: string
}

function prob(value: number): string {
  return value.toFixed(2)
}

function label(decision: CallDecision): string {
  switch (decision.action) {
    case 'keep': return decision.reason === 'pinned' ? 'keep (pinned)' : 'keep'
    case 'drop_result': return 'truncate result'
    case 'drop_call': return 'drop call'
  }
}

/**
 * Render the verdicts as a monospace table for `<pre>`-style viewers.
 *
 * @param decisions - per-call decisions, in call order.
 * @param stats - rebuild stats.
 * @param context - state-fitting and model header context.
 * @returns the report text.
 */
export function formatDecisionReport(
  decisions: readonly CallDecision[],
  stats: RebuildResult['stats'],
  context: ReportContext,
): string {
  const reduction = stats.charsBefore === 0
    ? 0
    : (1 - stats.charsAfter / stats.charsBefore) * 100
  const lines = [
    'fast-compaction-dsh verdict report',
    `state stage: ${context.stateStage} (~${context.stateTokens} tokens) · model: ${context.model}`,
    `messages ${stats.messagesBefore} → ${stats.messagesAfter} · `
      + `chars ${stats.charsBefore} → ${stats.charsAfter} (-${reduction.toFixed(1)}%)`,
    `calls ${stats.calls}: ${stats.kept} kept · ${stats.pinned} pinned · `
      + `${stats.resultsDropped} truncated · ${stats.callsDropped} dropped`,
    '',
    `${'id'.padEnd(8)}${'tool'.padEnd(26)}${'keepCall'.padEnd(10)}${'keepResult'.padEnd(12)}action`,
  ]
  for (const decision of decisions) {
    const tool = decision.tool.length > 24 ? `${decision.tool.slice(0, 23)}…` : decision.tool
    lines.push(
      `${decision.id.padEnd(8)}${tool.padEnd(26)}`
        + `${prob(decision.keepCall).padEnd(10)}${prob(decision.keepResult).padEnd(12)}`
        + label(decision),
    )
  }
  return lines.join('\n')
}
