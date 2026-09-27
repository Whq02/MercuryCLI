import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getOriginalCwd, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'

export type AdvisorRowKind = 'digest' | 'note' | 'question' | 'reply' | 'summary'

export interface AdvisorRow {
  kind: AdvisorRowKind
  at: string
  text: string
  cursor?: string
  turn?: number
  folded?: number
  model?: string
}

export interface AdvisorContext {
  agentId: string
  turns: number
  cursor: string | undefined
  rows: AdvisorRow[]
  path: string | null
}

export const ADVISOR_CONTEXT_SCHEMA = 1
export const ADVISOR_CONTEXT_DIR = 'advisor'
export const ADVISOR_COMPACT_KEEP = 6
export const ADVISOR_FOLD_RESERVE_TOKENS = 20_000
export const ADVISOR_SUMMARY_MAX_CHARS = 4000
export const ADVISOR_BYTES_PER_TOKEN = 4
const ADVISOR_ROW_TOKEN_OVERHEAD = 8
const FOLD_TRANSCRIPT_MAX_CHARS = 60_000
const FOLD_ROW_CLIP = 1200

const contexts = new Map<string, AdvisorContext>()

export function advisorContextDir(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), ADVISOR_CONTEXT_DIR)
}

export function advisorContextPath(agentId: string, dir: string = advisorContextDir()): string {
  return join(dir, `${agentId}.jsonl`)
}

function isRow(value: unknown): value is AdvisorRow {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.kind === 'digest' || v.kind === 'note' || v.kind === 'question' || v.kind === 'reply' || v.kind === 'summary') &&
    typeof v.at === 'string' &&
    typeof v.text === 'string'
  )
}

function rowLine(row: AdvisorRow): string {
  return `${JSON.stringify({ schema: ADVISOR_CONTEXT_SCHEMA, ...row })}\n`
}

function headLine(agentId: string): string {
  return `${JSON.stringify({ schema: ADVISOR_CONTEXT_SCHEMA, kind: 'head', agentId })}\n`
}

export function parseAdvisorContextLines(agentId: string, text: string): AdvisorRow[] {
  const rows: AdvisorRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRow(parsed)) continue
    const { schema: _schema, ...row } = parsed as AdvisorRow & { schema?: number }
    if (row.kind === 'summary' && typeof row.folded === 'number' && row.folded > 0) {
      rows.splice(0, row.folded)
      rows.unshift(row)
      continue
    }
    rows.push(row)
  }
  if (rows.length === 0) logForDebugging(`advisor: no rows read back for ${agentId}`)
  return rows
}

function lastCursor(rows: readonly AdvisorRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const cursor = rows[i]?.cursor
    if (cursor !== undefined) return cursor
  }
  return undefined
}

export async function loadAdvisorContext(
  agentId: string,
  opts: { dir?: string; persist?: boolean } = {},
): Promise<AdvisorContext> {
  const known = contexts.get(agentId)
  if (known !== undefined) return known
  const persist = opts.persist ?? true
  const path = persist ? advisorContextPath(agentId, opts.dir) : null
  let rows: AdvisorRow[] = []
  if (path !== null) {
    try {
      rows = parseAdvisorContextLines(agentId, await readFile(path, 'utf8'))
    } catch {
      rows = []
    }
  }
  const context: AdvisorContext = { agentId, turns: 0, cursor: lastCursor(rows), rows, path }
  contexts.set(agentId, context)
  return context
}

export function peekAdvisorContext(agentId: string): AdvisorContext | undefined {
  return contexts.get(agentId)
}

export function forgetAdvisorContext(agentId: string): void {
  contexts.delete(agentId)
}

export function resetAdvisorContextsForTests(): void {
  contexts.clear()
}

async function appendFoldMarker(context: AdvisorContext, marker: AdvisorRow): Promise<void> {
  if (context.path === null) return
  try {
    await appendFile(context.path, rowLine(marker), 'utf8')
  } catch (error) {
    logForDebugging(`advisor: could not append the fold to ${context.path} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function appendAdvisorRow(context: AdvisorContext, row: AdvisorRow): Promise<void> {
  const fresh = context.rows.length === 0
  context.rows.push(row)
  if (row.cursor !== undefined) context.cursor = row.cursor
  if (context.path === null) return
  try {
    await mkdir(dirname(context.path), { recursive: true })
    await appendFile(context.path, (fresh ? headLine(context.agentId) : '') + rowLine(row), 'utf8')
  } catch (error) {
    logForDebugging(`advisor: could not append to ${context.path} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function advisorRowTokens(row: AdvisorRow): number {
  return Math.ceil(row.text.length / ADVISOR_BYTES_PER_TOKEN) + ADVISOR_ROW_TOKEN_OVERHEAD
}

export function advisorGaugeTokens(context: Pick<AdvisorContext, 'rows'>): number {
  let total = 0
  for (const row of context.rows) total += advisorRowTokens(row)
  return total
}

export function advisorFoldThreshold(window: number): number {
  return Math.max(Math.floor(window / 2), window - ADVISOR_FOLD_RESERVE_TOKENS)
}

export function advisorShouldFold(tokens: number, window: number): boolean {
  return window > 0 && tokens >= advisorFoldThreshold(window)
}

export async function advisorWindowOf(model: string): Promise<number> {
  const { getEffectiveContextWindowSize } = await import('../compact/autoCompact.js')
  return getEffectiveContextWindowSize(model)
}

const roleWord = (row: AdvisorRow): string => {
  switch (row.kind) {
    case 'digest':
      return "the agent's conversation, as shown to you"
    case 'note':
      return 'your note to the agent'
    case 'question':
      return "the agent's question to you"
    case 'reply':
      return 'your reply'
    case 'summary':
      return 'your earlier memory, summarized'
  }
}

export function renderAdvisorFoldTranscript(rows: readonly AdvisorRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    const clipped = row.text.length > FOLD_ROW_CLIP ? `${row.text.slice(0, FOLD_ROW_CLIP)}…` : row.text
    if (clipped.trim().length > 0) lines.push(`[${roleWord(row)}] ${clipped.replace(/\s+/g, ' ')}`)
  }
  let out = lines.join('\n')
  if (out.length > FOLD_TRANSCRIPT_MAX_CHARS) {
    out = `[…older lines elided…]\n${out.slice(out.length - FOLD_TRANSCRIPT_MAX_CHARS)}`
  }
  return out
}

export function advisorCompactSummaryPrompt(): string {
  return [
    "You are summarizing the older portion of an advisor's own memory. The advisor is a second model that reads a working agent's conversation on a cadence and writes the agent short notes. The newest rows are kept verbatim; your summary REPLACES the older rows and is the advisor's only memory of them.",
    '',
    'Write these three numbered sections, each as terse plain prose (no markdown headings):',
    "1. The task and its state: what the agent is working on, what it has done, what it is doing now.",
    '2. Advice given: the course corrections, warnings and checks you already gave, so you never repeat one the agent has acted on and can press one it ignored.',
    '3. Open concerns: what you were watching for, what the agent still has to verify, anything unresolved.',
    '',
    'Report only what the rows state — never invent work or advice. Output the summary text alone: no preamble, no code fences.',
  ].join('\n')
}

export type AdvisorSummarizer = (args: { systemPrompt: string; transcript: string; modelId: string }) => Promise<string>

export interface AdvisorCompactResult {
  compacted: number
  refused?: string
}

export async function compactAdvisorContext(
  context: AdvisorContext,
  opts: { model: string; keep?: number; summarize?: AdvisorSummarizer },
): Promise<AdvisorCompactResult> {
  const keep = opts.keep ?? ADVISOR_COMPACT_KEEP
  if (context.rows.length <= keep) return { compacted: 0 }
  const fold = context.rows.slice(0, context.rows.length - keep)
  const tail = context.rows.slice(context.rows.length - keep)
  const summarize =
    opts.summarize ?? (await import('../concourse/coordinatorCompact.js')).liveCoordinatorSummarizer
  let summary: string
  try {
    summary = (await summarize({ systemPrompt: advisorCompactSummaryPrompt(), transcript: renderAdvisorFoldTranscript(fold), modelId: opts.model }))
      .trim()
      .slice(0, ADVISOR_SUMMARY_MAX_CHARS)
    if (summary.length === 0) return { compacted: 0, refused: 'the summarizer returned no text — nothing was folded' }
  } catch (error) {
    return { compacted: 0, refused: `the summary call failed — ${error instanceof Error ? error.message : String(error)}; nothing was folded` }
  }
  const marker: AdvisorRow = {
    kind: 'summary',
    at: new Date().toISOString(),
    text: summary,
    folded: fold.length,
    ...(context.cursor !== undefined && !tail.some(row => row.cursor !== undefined) ? { cursor: context.cursor } : {}),
  }
  context.rows = [marker, ...tail]
  await appendFoldMarker(context, marker)
  return { compacted: fold.length }
}

export async function maybeCompactAdvisorContext(
  context: AdvisorContext,
  opts: { model: string; window?: number; keep?: number; summarize?: AdvisorSummarizer },
): Promise<AdvisorCompactResult & { tokens: number; window: number }> {
  const window = opts.window ?? (await advisorWindowOf(opts.model))
  const tokens = advisorGaugeTokens(context)
  if (!advisorShouldFold(tokens, window)) return { compacted: 0, tokens, window }
  const result = await compactAdvisorContext(context, opts)
  if (result.refused !== undefined) logForDebugging(`advisor: ${context.agentId} memory fold refused — ${result.refused}`)
  return { ...result, tokens, window }
}
