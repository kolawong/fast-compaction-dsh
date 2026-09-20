#!/usr/bin/env node
/**
 * Inspect actual compaction outcomes recorded in DSH session logs.
 *
 * Offline and read-only: this scans `~/.dsh/sessions/**` artifacts
 * (`session.v3.jsonl` or `session.v3.jsonl.zstd`), finds every
 * `compaction/summary` event, and renders what happened — for the fast
 * engine that means the full per-call verdict table persisted in
 * `rawOutput` (tool, keepCall/keepResult probabilities, action), plus the
 * aggregate stats (chars before/after, calls kept/dropped/truncated).
 * Compactions written by the built-in summarizer are listed with their
 * shadowed counts and a summary excerpt instead.
 *
 * Nothing here is on the runtime path; run it whenever you want to look.
 *
 * Usage:
 *   node scripts/inspect-compaction.mjs [--all] [--workspace <substr>]
 *       [--session <substr>] [--json] [--no-color] [--limit <n>]
 *
 * Defaults to sessions whose header `cwd` equals the process cwd (i.e. run
 * it from the project you care about). `--all` scans every workspace.
 *
 * @module fast-compaction-dsh/scripts/inspect-compaction
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** @typedef {{ seq?: number, time?: number, type?: string, data?: any }} SessionRow */

const args = process.argv.slice(2)

function optionValue(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const hasFlag = name => args.includes(name)

const scanAll = hasFlag('--all')
const workspaceFilter = optionValue('--workspace')?.toLowerCase()
const sessionFilter = optionValue('--session')?.toLowerCase()
const jsonMode = hasFlag('--json')
const limitRaw = optionValue('--limit')
const limit = limitRaw === undefined ? undefined : Math.max(1, Number.parseInt(limitRaw, 10))
const useColor = !hasFlag('--no-color') && process.stdout.isTTY === true

const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text)
const bold = text => paint('1', text)
const dim = text => paint('2', text)
const green = text => paint('32', text)
const yellow = text => paint('33', text)
const red = text => paint('31', text)
const cyan = text => paint('36', text)

const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions')
const ARTIFACT_NAMES = ['session.v3.jsonl.zstd', 'session.v3.jsonl']

/** Read one session artifact to text, tolerating plain and zstd encodings. */
function readArtifact(path) {
  if (path.endsWith('.zstd')) return zstdDecompressSync(readFileSync(path)).toString('utf8')
  return readFileSync(path, 'utf8')
}

/** Parse a session artifact into its header row and compaction event rows. */
function parseArtifact(path) {
  let text
  try {
    text = readArtifact(path)
  } catch (error) {
    return { error: `unreadable: ${error.message}` }
  }
  /** @type {any} */ let header = null
  /** @type {SessionRow[]} */ const compactionEvents = []
  let lines = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    lines += 1
    /** @type {SessionRow} */ let row
    try {
      row = JSON.parse(line)
    } catch {
      continue // torn tail write; the store itself recovers from these
    }
    if (row.type === 'session') {
      header = row
      continue
    }
    if (typeof row.type === 'string' && row.type.startsWith('compaction/')) {
      compactionEvents.push(row)
    }
  }
  return { header, compactionEvents, lines }
}

/** Extract the fast engine's `{decisions, stats, stateStage}` payload, when present. */
function fastPayload(data) {
  if (!Array.isArray(data?.rawOutput)) return undefined
  for (const block of data.rawOutput) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed = JSON.parse(block.text)
      if (parsed && Array.isArray(parsed.decisions) && parsed.stats !== undefined) return parsed
    } catch {
      // not ours
    }
  }
  return undefined
}

function fmtTime(time) {
  return typeof time === 'number' ? new Date(time).toLocaleString() : '?'
}

function fmtProb(value) {
  return typeof value === 'number' ? value.toFixed(2) : '  — '
}

function pad(text, width) {
  const plain = text.replace(/\[\d+m/g, '')
  return text + ' '.repeat(Math.max(0, width - plain.length))
}

function actionLabel(action, reason) {
  switch (action) {
    case 'keep': return reason === 'pinned' ? dim('keep  (pinned)') : green('keep')
    case 'drop_result': return yellow('truncate result')
    case 'drop_call': return red('drop call')
    default: return String(action)
  }
}

/** Render one compaction/summary event. */
function renderSummary(row, index) {
  const data = row.data ?? {}
  const out = []
  const engine = fastPayload(data)
  const headline = engine
    ? cyan(`fast-compaction (verdict) — ${data.provider ?? 'typesafe'}/${data.model ?? '?'}`)
    : dim(`built-in summary — ${data.provider ?? '?'}/${data.model ?? '?'}`)
  out.push(`  ${bold(`#${index}`)} ${fmtTime(row.time)}  ${headline}  ${dim(`seq ${row.seq ?? '?'}`)}`)
  const shadowed = []
  if (Array.isArray(data.shadowedSeqs)) shadowed.push(`${data.shadowedSeqs.length} items`)
  if (typeof data.shadowedTokenCount === 'number') shadowed.push(`~${data.shadowedTokenCount} tokens shadowed`)
  if (data.usage !== undefined) {
    shadowed.push(`summarize usage in=${data.usage.inputTokens ?? '?'} out=${data.usage.outputTokens ?? '?'}`)
  }
  if (shadowed.length > 0) out.push(`     ${dim(shadowed.join(' · '))}`)

  if (engine === undefined) {
    const text = Array.isArray(data.summary)
      ? data.summary.map(block => (block?.type === 'text' ? block.text : '')).join('')
      : ''
    if (text.trim().length > 0) {
      out.push(`     ${dim('summary excerpt:')} ${text.trim().slice(0, 160).replaceAll('\n', ' ')}${text.trim().length > 160 ? '…' : ''}`)
    }
    return out
  }

  const { decisions, stats, stateStage } = engine
  const reduction = stats.charsBefore === 0 ? 0 : (1 - stats.charsAfter / stats.charsBefore) * 100
  out.push(
    `     ${bold('stats:')} messages ${stats.messagesBefore} → ${stats.messagesAfter}, `
    + `chars ${stats.charsBefore} → ${stats.charsAfter} (${green(`-${reduction.toFixed(1)}%`)}), `
    + `calls ${stats.calls}: ${green(`${stats.kept} kept`)} · ${dim(`${stats.pinned} pinned`)} · `
    + `${yellow(`${stats.resultsDropped} truncated`)} · ${red(`${stats.callsDropped} dropped`)}`
    + (typeof stateStage === 'string' ? ` · state stage ${stateStage}` : ''),
  )
  out.push(`     ${dim('id      tool'.padEnd(34) + 'keepCall  keepResult  action')}`)
  for (const decision of decisions) {
    const tool = String(decision.tool ?? '?')
    const name = tool.length > 22 ? `${tool.slice(0, 21)}…` : tool
    out.push(
      `     ${String(decision.id ?? '?').padEnd(8)}${name.padEnd(26)}`
      + `${fmtProb(decision.keepCall)}      ${fmtProb(decision.keepResult)}       `
      + actionLabel(decision.action, decision.reason),
    )
  }
  return out
}

/** Collect candidate session artifact paths across workspaces. */
function collectArtifacts() {
  const artifacts = []
  if (!existsSync(SESSIONS_ROOT)) return artifacts
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    if (workspaceFilter !== undefined && !workspace.toLowerCase().includes(workspaceFilter)) continue
    const workspaceDir = join(SESSIONS_ROOT, workspace)
    if (statSync(workspaceDir).isDirectory() === false) continue
    for (const session of readdirSync(workspaceDir)) {
      if (sessionFilter !== undefined && !session.toLowerCase().includes(sessionFilter)) continue
      const sessionDir = join(workspaceDir, session)
      if (statSync(sessionDir).isDirectory() === false) continue
      for (const name of ARTIFACT_NAMES) {
        const path = join(sessionDir, name)
        if (existsSync(path)) {
          artifacts.push({ workspace, session, path })
          break
        }
      }
    }
  }
  return artifacts
}

const artifacts = collectArtifacts()
const report = []
let totalCompactions = 0
let fastCompactions = 0

for (const artifact of artifacts) {
  const { header, compactionEvents, lines, error } = parseArtifact(artifact.path)
  if (error !== undefined) {
    if (jsonMode) report.push({ session: artifact.session, error })
    else console.log(dim(`${artifact.session}: ${error}`))
    continue
  }
  if (!scanAll && workspaceFilter === undefined && header?.cwd !== undefined && header.cwd !== process.cwd()) continue
  const summaries = compactionEvents.filter(row => row.type === 'compaction/summary')
  if (summaries.length === 0) continue
  const starts = compactionEvents.filter(row => row.type === 'compaction/start').length
  const errors = compactionEvents.filter(row => row.type === 'compaction/end' && row.data?.error !== undefined)
  const shown = limit === undefined ? summaries : summaries.slice(-limit)

  if (jsonMode) {
    report.push({
      session: artifact.session,
      cwd: header?.cwd ?? null,
      agentPreset: header?.agentPreset ?? null,
      compactions: shown.map(row => ({
        seq: row.seq ?? null,
        time: row.time ?? null,
        provider: row.data?.provider ?? null,
        model: row.data?.model ?? null,
        shadowedItems: Array.isArray(row.data?.shadowedSeqs) ? row.data.shadowedSeqs.length : null,
        shadowedTokenCount: row.data?.shadowedTokenCount ?? null,
        fast: fastPayload(row.data) ?? null,
      })),
    })
    continue
  }

  console.log(bold(`\n${header?.cwd ?? artifact.workspace} ${dim(`— ${artifact.session}`)}`))
  console.log(dim(`  ${artifact.path} (${lines} events, preset ${header?.agentPreset ?? '?'})`))
  console.log(`  compactions: ${summaries.length} (starts ${starts}${errors.length > 0 ? red(`, ${errors.length} failed`) : ''})`)
  for (const [index, row] of shown.entries()) {
    console.log(renderSummary(row, index + 1).join('\n'))
  }
  totalCompactions += shown.length
  fastCompactions += shown.filter(row => fastPayload(row.data) !== undefined).length
}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('')
  if (totalCompactions === 0) {
    console.log(yellow('No compaction events found.'))
    console.log(dim('Trigger one: run /compact in a session on the fast preset, or lower thresholdRatio in the preset config.'))
  } else {
    console.log(bold(`Total: ${totalCompactions} compaction(s), ${fastCompactions} via fast-compaction verdicts.`))
  }
}
