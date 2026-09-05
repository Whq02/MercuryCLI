


import { projectHomeStore } from '../projectHomeStores.js'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'

export function evolutionLedgerEnabled(): boolean {
  return flagEnabled('MERCURY_EVOLUTION_LEDGER')
}

export const EVOLUTION_OUTCOMES = [
  'baseline',
  'improved',
  'regressed',
  'tie',
  'accepted',
  'refused',
  'error',
] as const
export type EvolutionOutcome = (typeof EVOLUTION_OUTCOMES)[number]

export interface EvolutionScore {
  dev?: number
  holdout?: number
  unit?: string
}

export interface EvolutionRow {
  ts: string
  program: string
  iteration?: number
  subject: string
  outcome: EvolutionOutcome
  hypothesis?: string
  mechanism?: string
  lineage?: string
  score?: EvolutionScore
  delta?: number
  evidenceRefs?: string[]
  notes?: string
}

const CAP = {
  program: 120,
  subject: 200,
  hypothesis: 600,
  mechanism: 240,
  lineage: 200,
  notes: 600,
  evidenceRef: 400,
  evidenceRefs: 12,
  unit: 40,
} as const

const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function slugForProgram(program: string): string {
  const p = String(program ?? '')
  const slug = p.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'program'
  const hash = createHash('sha256').update(p).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

export function defaultEvolutionLedgerDir(cwd: string): string {
  return projectHomeStore(cwd, 'evolution')
}

export function getEvolutionLedgerPath(ledgerDir: string, program: string): string {
  return join(ledgerDir, `${slugForProgram(program)}.jsonl`)
}

const MAX_LINES = 5000
const KEEP_LINES = 2500
const MIN_ROW_BYTES = 64
const TRIM_PROBE_BYTES = MAX_LINES * MIN_ROW_BYTES
const HARD_TRIM_BYTES = 4 * 1024 * 1024

const writeChains = new Map<string, Promise<void>>()

export type WriteRowResult =
  | { ok: true; path: string; deduped?: boolean }
  | { ok: false; reason: string }

export interface WriteRowOptions {
  dedupe?: boolean
}

export function validateEvolutionRow(
  input: Omit<EvolutionRow, 'ts'> & { ts?: string },
): { ok: true; row: EvolutionRow } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'row must be an object' }
  const program = typeof input.program === 'string' ? input.program.trim() : ''
  if (!program) return { ok: false, reason: 'program is required' }
  const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!subject) return { ok: false, reason: 'subject is required' }
  const outcome = input.outcome
  if (!EVOLUTION_OUTCOMES.includes(outcome as EvolutionOutcome)) {
    return { ok: false, reason: `outcome must be one of: ${EVOLUTION_OUTCOMES.join(', ')}` }
  }
  const refs = Array.isArray(input.evidenceRefs)
    ? input.evidenceRefs
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .slice(0, CAP.evidenceRefs)
        .map(r => clamp(r.trim(), CAP.evidenceRef))
    : []
  if ((outcome === 'improved' || outcome === 'accepted') && refs.length === 0) {
    return {
      ok: false,
      reason: `'${outcome}' requires at least one evidenceRef anchor (gate output, transcript path, commit) — claims without captured signal are refused`,
    }
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const str = (v: unknown, cap: number): string | undefined =>
    typeof v === 'string' && v.trim() ? clamp(v.trim(), cap) : undefined
  const score: EvolutionScore | undefined =
    input.score && typeof input.score === 'object'
      ? {
          ...(num((input.score as EvolutionScore).dev) !== undefined ? { dev: num((input.score as EvolutionScore).dev) } : {}),
          ...(num((input.score as EvolutionScore).holdout) !== undefined ? { holdout: num((input.score as EvolutionScore).holdout) } : {}),
          ...(str((input.score as EvolutionScore).unit, CAP.unit) ? { unit: str((input.score as EvolutionScore).unit, CAP.unit) } : {}),
        }
      : undefined
  const tsOk = typeof input.ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input.ts)
  const row: EvolutionRow = {
    ts: tsOk ? (input.ts as string) : new Date().toISOString(),
    program: clamp(program, CAP.program),
    subject: clamp(subject, CAP.subject),
    outcome: outcome as EvolutionOutcome,
    ...(num(input.iteration) !== undefined ? { iteration: num(input.iteration) } : {}),
    ...(str(input.hypothesis, CAP.hypothesis) ? { hypothesis: str(input.hypothesis, CAP.hypothesis) } : {}),
    ...(str(input.mechanism, CAP.mechanism) ? { mechanism: str(input.mechanism, CAP.mechanism) } : {}),
    ...(str(input.lineage, CAP.lineage) ? { lineage: str(input.lineage, CAP.lineage) } : {}),
    ...(score && Object.keys(score).length > 0 ? { score } : {}),
    ...(num(input.delta) !== undefined ? { delta: num(input.delta) } : {}),
    ...(refs.length > 0 ? { evidenceRefs: refs } : {}),
    ...(str(input.notes, CAP.notes) ? { notes: str(input.notes, CAP.notes) } : {}),
  }
  return { ok: true, row }
}

export function writeEvolutionRow(
  ledgerDir: string,
  input: Omit<EvolutionRow, 'ts'> & { ts?: string },
  options: WriteRowOptions = {},
): Promise<WriteRowResult> {
  if (!evolutionLedgerEnabled()) return Promise.resolve({ ok: false, reason: 'gated (MERCURY_EVOLUTION_LEDGER off)' })
  const validated = validateEvolutionRow(input)
  if (!validated.ok) return Promise.resolve({ ok: false, reason: validated.reason })
  const path = getEvolutionLedgerPath(ledgerDir, validated.row.program)
  const prev = writeChains.get(path) ?? Promise.resolve()
  const next: Promise<WriteRowResult> = prev.then(() => appendRow(path, validated.row, options))
  const link = next.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(path, link)
  void link.finally(() => {
    if (writeChains.get(path) === link) writeChains.delete(path)
  })
  return next
}

const identityTuple = (r: EvolutionRow): string =>
  JSON.stringify([r.program, r.subject, r.outcome, r.iteration ?? null, r.hypothesis ?? '', r.mechanism ?? ''])

const DEDUPE_SCAN_TAIL = 200

async function appendRow(path: string, row: EvolutionRow, options: WriteRowOptions = {}): Promise<WriteRowResult> {
  try {
    await mkdir(join(path, '..'), { recursive: true })
    if (options.dedupe) {
      const existing = await readFile(path, 'utf-8').catch(() => '')
      if (existing) {
        const key = identityTuple(row)
        const tail = existing.split('\n').filter(Boolean).slice(-DEDUPE_SCAN_TAIL)
        for (const line of tail) {
          try {
            const rec = JSON.parse(line) as EvolutionRow
            if (identityTuple(rec) === key) return { ok: true, path, deduped: true }
          } catch {
          }
        }
      }
    }
    await appendFile(path, JSON.stringify(row) + '\n', 'utf-8')
    const st = await stat(path)
    if (st.size > TRIM_PROBE_BYTES) {
      const lines = (await readFile(path, 'utf-8')).split('\n').filter(Boolean)
      if (lines.length > MAX_LINES || st.size > HARD_TRIM_BYTES) {
        const kept: string[] = []
        let bytes = 0
        for (let i = lines.length - 1; i >= 0 && kept.length < KEEP_LINES; i--) {
          bytes += lines[i]!.length + 1
          if (bytes > HARD_TRIM_BYTES / 2 && kept.length > 0) break
          kept.push(lines[i]!)
        }
        kept.reverse()
        await writeFile(path, kept.join('\n') + '\n', 'utf-8')
      }
    }
    return { ok: true, path }
  } catch (e) {
    logForDebugging(`[evolution] could not write row for ${row.program}: ${e}`)
    return { ok: false, reason: `write failed: ${e}` }
  }
}

export function makeWorkflowLedgerHost(
  ledgerDir: string,
  runEvidenceRef?: string,
): {
  record(row: unknown): Promise<WriteRowResult>
  read(program: unknown): Promise<EvolutionRow[]>
  report(program: unknown): Promise<string>
} {
  return {
    async record(row: unknown): Promise<WriteRowResult> {
      const r = (row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : {}) as Omit<
        EvolutionRow,
        'ts'
      > & { ts?: string }
      if (runEvidenceRef) {
        const refs = Array.isArray(r.evidenceRefs) ? [...r.evidenceRefs] : []
        if (!refs.includes(runEvidenceRef)) refs.push(runEvidenceRef)
        r.evidenceRefs = refs
      }
      return writeEvolutionRow(ledgerDir, r, { dedupe: true })
    },
    async read(program: unknown): Promise<EvolutionRow[]> {
      return readEvolutionRows(ledgerDir, String(program ?? ''))
    },
    async report(program: unknown): Promise<string> {
      const p = String(program ?? '')
      const rows = await readEvolutionRows(ledgerDir, p)
      return renderEvolutionReport(summarizeEvolution(p, rows), rows)
    },
  }
}

export function parseEvolutionRowsText(text: string): EvolutionRow[] {
  const out: EvolutionRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (
        rec &&
        typeof rec === 'object' &&
        typeof rec.program === 'string' &&
        typeof rec.subject === 'string' &&
        EVOLUTION_OUTCOMES.includes(rec.outcome)
      ) {
        out.push(rec as EvolutionRow)
      }
    } catch {
    }
  }
  return out
}

export async function readEvolutionRows(ledgerDir: string, program: string): Promise<EvolutionRow[]> {
  try {
    return parseEvolutionRowsText(await readFile(getEvolutionLedgerPath(ledgerDir, program), 'utf-8'))
  } catch {
    return []
  }
}

export interface EvolutionFrontier {
  bestBySubject: Record<string, { score: number; iteration?: number; ts: string }>
  best?: { subject: string; score: number; iteration?: number; ts: string }
  dryIterations: number
  lastImprovedTs?: string
}

const frontierMetric = (r: EvolutionRow): number | undefined =>
  r.score?.holdout !== undefined ? r.score.holdout : r.score?.dev

export function computeEvolutionFrontier(rows: EvolutionRow[]): EvolutionFrontier {
  const bestBySubject: EvolutionFrontier['bestBySubject'] = {}
  let best: EvolutionFrontier['best']
  let lastImprovedTs: string | undefined
  for (const r of rows) {
    const m = frontierMetric(r)
    if (m !== undefined) {
      const cur = bestBySubject[r.subject]
      if (!cur || m > cur.score) {
        bestBySubject[r.subject] = { score: m, ...(r.iteration !== undefined ? { iteration: r.iteration } : {}), ts: r.ts }
      }
      if (!best || m > best.score) {
        best = { subject: r.subject, score: m, ...(r.iteration !== undefined ? { iteration: r.iteration } : {}), ts: r.ts }
      }
    }
    if (r.outcome === 'improved') lastImprovedTs = r.ts
  }
  const iters = new Map<number, boolean>()
  for (const r of rows) {
    if (r.iteration === undefined) continue
    iters.set(r.iteration, (iters.get(r.iteration) ?? false) || r.outcome === 'improved')
  }
  let dryIterations = 0
  for (const it of [...iters.keys()].sort((a, b) => b - a)) {
    if (iters.get(it)) break
    dryIterations++
  }
  return { bestBySubject, ...(best ? { best } : {}), dryIterations, ...(lastImprovedTs ? { lastImprovedTs } : {}) }
}

export interface EvolutionSummary {
  program: string
  total: number
  byOutcome: Record<string, number>
  recentByOutcome: Record<string, number>
  recentWindow: number
  frontier: EvolutionFrontier
  firstTs?: string
  lastTs?: string
}

export const EVOLUTION_RECENT_WINDOW = 25

export function summarizeEvolution(program: string, rows: EvolutionRow[]): EvolutionSummary {
  const byOutcome: Record<string, number> = {}
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
  const recent = rows.slice(-EVOLUTION_RECENT_WINDOW)
  const recentByOutcome: Record<string, number> = {}
  for (const r of recent) recentByOutcome[r.outcome] = (recentByOutcome[r.outcome] ?? 0) + 1
  const first = rows[0]
  const last = rows[rows.length - 1]
  return {
    program,
    total: rows.length,
    byOutcome,
    recentByOutcome,
    recentWindow: recent.length,
    frontier: computeEvolutionFrontier(rows),
    ...(first ? { firstTs: first.ts } : {}),
    ...(last ? { lastTs: last.ts } : {}),
  }
}

export interface SubjectDrift {
  subject: string
  total: number
  accepted: number
  refused: number
  error: number
  acceptRate: number | null
  recentAcceptRate: number | null
  priorAcceptRate: number | null
}

export function computeSubjectDrift(rows: EvolutionRow[]): SubjectDrift[] {
  const bySubject = new Map<string, EvolutionRow[]>()
  for (const r of rows) {
    const arr = bySubject.get(r.subject)
    if (arr) arr.push(r)
    else bySubject.set(r.subject, [r])
  }
  const out: SubjectDrift[] = []
  const rate = (recs: EvolutionRow[]): number | null =>
    recs.length === 0 ? null : recs.filter(r => r.outcome === 'accepted' || r.outcome === 'improved').length / recs.length
  for (const [subject, recs] of bySubject) {
    const recentN = Math.min(25, Math.max(1, Math.floor(recs.length / 2)) )
    const recent = recs.slice(-recentN)
    const prior = recs.slice(0, recs.length - recentN)
    out.push({
      subject,
      total: recs.length,
      accepted: recs.filter(r => r.outcome === 'accepted' || r.outcome === 'improved').length,
      refused: recs.filter(r => r.outcome === 'refused').length,
      error: recs.filter(r => r.outcome === 'error').length,
      acceptRate: rate(recs),
      recentAcceptRate: rate(recent),
      priorAcceptRate: prior.length > 0 ? rate(prior) : null,
    })
  }
  return out.sort((a, b) => b.total - a.total)
}

export function renderEvolutionReport(summary: EvolutionSummary, rows: EvolutionRow[]): string {
  const lines: string[] = []
  const f = summary.frontier
  lines.push(`evolution: ${summary.program}`)
  lines.push(
    `  rows ${summary.total}` +
      (summary.firstTs ? `  span ${summary.firstTs.slice(0, 10)} → ${(summary.lastTs ?? '').slice(0, 10)}` : ''),
  )
  const fmt = (o: Record<string, number>): string =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || '(none)'
  lines.push(`  all-time  ${fmt(summary.byOutcome)}`)
  lines.push(`  recent-${summary.recentWindow}  ${fmt(summary.recentByOutcome)}`)
  if (f.best) {
    lines.push(
      `  frontier  ${f.best.subject} @ ${f.best.score}${f.best.iteration !== undefined ? ` (iter ${f.best.iteration})` : ''}`,
    )
  }
  lines.push(`  dry iterations since last improvement: ${f.dryIterations}`)
  const tail = rows.slice(-8)
  if (tail.length > 0) {
    lines.push('  recent rows:')
    for (const r of tail) {
      const m = frontierMetric(r)
      lines.push(
        `    ${r.ts.slice(0, 16)}  ${r.outcome.padEnd(9)} ${r.subject}` +
          (m !== undefined ? `  score=${m}` : '') +
          (r.delta !== undefined ? `  Δ${r.delta > 0 ? '+' : ''}${r.delta}` : '') +
          (r.evidenceRefs?.length ? `  evidence: ${r.evidenceRefs[0]}${r.evidenceRefs.length > 1 ? ` (+${r.evidenceRefs.length - 1})` : ''}` : ''),
      )
    }
  }
  return lines.join('\n')
}
