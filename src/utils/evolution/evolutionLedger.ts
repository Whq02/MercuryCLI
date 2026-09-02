/* ============================================================================
   evolutionLedger — the append-only EPISTEMIC ledger for improvement programs.

   Methodology adapted from Meta-Harness (Lee et al., arXiv:2603.28052 — MIT,
   © 2026 Yoonho Lee: evolution_summary.jsonl + frontier as the optimizer's
   filesystem state) and Adaptive Auto-Harness (Liu et al., arXiv:2606.01770 —
   MIT, © 2026 A-EVO-Lab: RoutingEntry outcome rows + drift arithmetic). No
   code vendored; TS re-implementation against Mercury's own seams.

   What this is: Mercury runs repeated improvement programs — patch-loop
   artifact evolution, memdir distill/promote, hardening/audit rounds — and
   each one re-derives its own tracking, so round N+1 cannot cheaply read what
   round N tried, what improved, and where the raw evidence lives. This ledger
   is the missing cross-run record: one JSONL row per attempt/decision, keyed
   by PROGRAM, with the Meta-Harness row vocabulary (hypothesis · mechanism ·
   lineage · score · delta) plus evidenceRefs — pointers to raw traces/gate
   output, honoring the paper's central ablation (raw-trace access 50.0 vs
   scores+summaries 34.9: never make a future reader depend on a summary when
   it can dereference the evidence).

   Anti-confabulation gate (Honest Lying, arXiv:2605.29463 — the same rule as
   MERCURY_CARD_TRACE_GROUND): a row CLAIMING 'improved' or 'accepted' must carry at
   least one evidenceRef anchor, or it is refused. Cheap talk stays out of the
   record that future rounds trust.

   Posture (mirrors daemon/fireOutcomeLedger): best-effort, never throws,
   O_APPEND single-write hot path, per-path write chains against in-process
   clobber, bounded trim, closed outcome taxonomy, pure readers/summarizers.
   Free-text fields are length-CLAMPED, and the ledger lives under the
   caller-chosen ledger dir (default <cwd>/.mercury/evolution/ via the
   canonical-write project resolver, adoptiveProjectPath — gitignored
   operational state, same risk class as the workflow run manifests — never
   config-home-global, never injected into prompts unqueried). Caveat for the
   memdir writer (<memoryDir>/evolution/): the default auto-memory dir is
   config-home-scoped, but a host that points autoMemoryDirectory at a
   repo-local path will see this JSONL in its diffs — bounded by the trim, and
   the same posture as the cards written beside it.

   GATING: MERCURY_EVOLUTION_LEDGER (flagRegistry, default-on). OFF ⇒ writes
   no-op, no file is created ⇒ byte-identical.
   ============================================================================ */

import { adoptiveProjectPath } from '../projectStoreAdoption.js'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'

export function evolutionLedgerEnabled(): boolean {
  return flagEnabled('MERCURY_EVOLUTION_LEDGER')
}

/** Closed outcome taxonomy — every recorded attempt/decision maps to one. */
export const EVOLUTION_OUTCOMES = [
  'baseline', //  the incumbent's initial measurement (iteration 0 of a program)
  'improved', //  candidate beat the frontier (requires evidenceRefs)
  'regressed', // candidate scored below the frontier
  'tie', //       candidate matched the frontier (no admit)
  'accepted', //  candidate/artifact admitted or promoted (requires evidenceRefs)
  'refused', //   structurally refused before/without scoring (dedup, leakage, gate)
  'error', //     the attempt itself crashed / could not be evaluated
] as const
export type EvolutionOutcome = (typeof EVOLUTION_OUTCOMES)[number]

export interface EvolutionScore {
  /** dev/search-split measurement (pass count or rate — the writer's unit). */
  dev?: number
  /** held-out measurement — the FRONTIER metric when present (anti-leakage:
   *  writers must never let the proposer read holdout content, only results). */
  holdout?: number
  /** what the numbers count ('scenarios', 'suites', 'checks') — for the report. */
  unit?: string
}

export interface EvolutionRow {
  ts: string
  /** ledger key — one improvement program, e.g. 'patch-loop:fable-pack'. */
  program: string
  /** outer-loop round; baseline rows use 0. */
  iteration?: number
  /** the candidate/artifact/problemClass this row is about. */
  subject: string
  outcome: EvolutionOutcome
  /** the falsifiable claim behind the attempt (Meta-Harness contract). */
  hypothesis?: string
  /** the ONE mechanism changed — 'and also' means two rows. */
  mechanism?: string
  /** parent subject this candidate derived from (lineage edge). */
  lineage?: string
  score?: EvolutionScore
  /** score minus the frontier at attempt time (writer-computed). */
  delta?: number
  /** anchors into captured signal: file paths, commit SHAs, gate output,
   *  transcript paths. REQUIRED for 'improved'/'accepted'. */
  evidenceRefs?: string[]
  notes?: string
}

// ── field clamps (defensive: the workflow script global feeds VM-sourced input) ──
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

/** Slug a program name for its ledger filename. The readable prefix is for
 *  humans; the hash suffix keeps two distinct programs from colliding after
 *  sanitization (the fireOutcomeLedger slugForDir lesson). */
export function slugForProgram(program: string): string {
  const p = String(program ?? '')
  const slug = p.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'program'
  const hash = createHash('sha256').update(p).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

/** The DEFAULT ledger dir for a repo checkout — operational state, gitignored
 *  via `.mercury/*`. Writers with their own home (the memdir) pass an explicit
 *  dir instead (e.g. `<memoryDir>/evolution`). */
export function defaultEvolutionLedgerDir(cwd: string): string {
  return adoptiveProjectPath(cwd, 'evolution')
}

/** ledgerDir is the DIRECTORY holding the program ledgers (one .jsonl each). */
export function getEvolutionLedgerPath(ledgerDir: string, program: string): string {
  return join(ledgerDir, `${slugForProgram(program)}.jsonl`)
}

// Bounded ledger (an autonomous patch-loop can run for days).
const MAX_LINES = 5000
const KEEP_LINES = 2500
// LOWER bound on one serialized row: fixed keys + ISO ts (24) + 1-char
// program/subject + the shortest outcome measure ~70B, so 64 sits just under
// the true minimum — the size probe then NEVER skips a due trim, only runs
// the O(n) read a touch early (the fireOutcomeLedger MIN_RECORD_BYTES lesson:
// an OVERestimate silently defers trims on ledgers full of small rows — the
// first proof run caught exactly that at the prior value of 120).
const MIN_ROW_BYTES = 64
const TRIM_PROBE_BYTES = MAX_LINES * MIN_ROW_BYTES
// HARD byte ceiling for the trim itself (not just the probe): a ledger of
// maximally-clamped rows (~7.5KB each) can sit under MAX_LINES while being
// tens of MB — every append would then pay a whole-file read that never
// trims. Past this cap the tail is kept regardless of line count.
const HARD_TRIM_BYTES = 4 * 1024 * 1024

// Per-path write serialization: concurrent writers (a workflow's parallel()
// stages, the CLI racing a session) each O_APPEND atomically, but the
// read-modify-write TRIM must never interleave with another in-process append.
const writeChains = new Map<string, Promise<void>>()

export type WriteRowResult =
  | { ok: true; path: string; deduped?: boolean }
  | { ok: false; reason: string }

export interface WriteRowOptions {
  /** Skip the append when an identical identity tuple (program · subject ·
   *  outcome · iteration · hypothesis · mechanism) already exists in the
   *  ledger tail. The workflow script global sets this: on RESUME the script
   *  body re-executes and only agent() calls replay from the journal, so a
   *  bare re-append would double-count. Event-counting writers (memdir drift
   *  rows) must NOT set it — their repeats are the signal. */
  dedupe?: boolean
}

/** Validate + clamp a row from an untrusted caller. Pure. */
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
  // Honest-Lying gate: an improvement/acceptance claim without a captured-signal
  // anchor is exactly the confabulation future rounds re-apply. Refuse it.
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
  // ts must LOOK like an ISO instant (reports slice it positionally; frontier
  // ordering trusts it) — a VM script's garbage string is coerced to now.
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

/**
 * Append one row (best-effort; never throws; serialized per ledger path).
 * OFF ⇒ {ok:false, reason:'gated'} and NO file is touched (byte-identical).
 */
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
  // The chain stores a void projection; evict when THIS link is still the tail
  // (appendRow never rejects, so the link always settles and can't stall peers).
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

/** The identity tuple for opt-in dedupe (ts deliberately excluded — a resumed
 *  re-execution stamps a new ts but is the SAME semantic event). */
const identityTuple = (r: EvolutionRow): string =>
  JSON.stringify([r.program, r.subject, r.outcome, r.iteration ?? null, r.hypothesis ?? '', r.mechanism ?? ''])

// Only the ledger tail is scanned for a duplicate — bounded work per write.
const DEDUPE_SCAN_TAIL = 200

/** Serialized write body — atomic append + cheap bounded trim. Never throws. */
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
            /* garbage line — not a duplicate */
          }
        }
      }
    }
    await appendFile(path, JSON.stringify(row) + '\n', 'utf-8')
    const st = await stat(path)
    if (st.size > TRIM_PROBE_BYTES) {
      const lines = (await readFile(path, 'utf-8')).split('\n').filter(Boolean)
      if (lines.length > MAX_LINES || st.size > HARD_TRIM_BYTES) {
        // Keep a tail bounded on BOTH axes: ≤ KEEP_LINES rows AND ≤ half the
        // byte cap (a plain slice(-KEEP_LINES) keeps everything when fat rows
        // trip the byte trigger under the line count — the first draft of this
        // guard had exactly that hole). Always keep the newest row.
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

/**
 * The workflow-engine host surface behind the script `ledger` global (the
 * executor's EvolutionLedgerHost — injected by WorkflowTool.tsx only when the
 * gate is live). Two host-side policies live here, not in the VM:
 *   · every record() is auto-annotated with the run's evidence anchor
 *     (workflow-run:<id> + the transcript dir), so a row written from a run is
 *     always dereferenceable back to its raw traces (Meta-Harness: the traces
 *     ARE the memory), and
 *   · dedupe:true — a resumed script re-executes its body and only agent()
 *     calls replay from the journal; identity-tuple dedupe keeps the re-run
 *     from double-appending the same semantic rows.
 */
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

/** Parse ledger JSONL text into validated rows (best-effort; malformed lines
 *  skipped). Pure — shared by readEvolutionRows and the /ledger dir scanner. */
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
      /* skip a partial/garbage line */
    }
  }
  return out
}

/** Parse one program's ledger (best-effort; malformed lines skipped). Read-only —
 *  works regardless of the gate, so past ledgers stay inspectable after opt-out. */
export async function readEvolutionRows(ledgerDir: string, program: string): Promise<EvolutionRow[]> {
  try {
    return parseEvolutionRowsText(await readFile(getEvolutionLedgerPath(ledgerDir, program), 'utf-8'))
  } catch {
    return []
  }
}

export interface EvolutionFrontier {
  /** best row per subject by the frontier metric (holdout > dev precedence). */
  bestBySubject: Record<string, { score: number; iteration?: number; ts: string }>
  /** the overall best-scoring row, if any row carried a score. */
  best?: { subject: string; score: number; iteration?: number; ts: string }
  /** consecutive most-recent iterations with no 'improved' row — the dry-stop
   *  signal (ATLAS-style allocation: convergence IS the stop signal). */
  dryIterations: number
  lastImprovedTs?: string
}

const frontierMetric = (r: EvolutionRow): number | undefined =>
  r.score?.holdout !== undefined ? r.score.holdout : r.score?.dev

/** Pure frontier over a program's rows (list order = time order). */
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
  // dry run-length in ITERATIONS: walk distinct iterations newest-first until
  // one contains an 'improved' row. Rows without an iteration are ignored here.
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

/** Roll up one program's rows (for the report + drift view). Pure. */
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
  /** accepted / total over ALL rows for the subject (null when total = 0). */
  acceptRate: number | null
  /** accepted / count over the subject's RECENT half (cap 25) vs its PRIOR rows —
   *  the AdaptiveHarness recent-vs-prior drift arithmetic (RoutingEntry). */
  recentAcceptRate: number | null
  priorAcceptRate: number | null
}

/** Pure per-subject drift rollup (the drift-rollup arithmetic — JSONL
 *  parse + division, no engine). List order = time order. */
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

/** Render the read-only report (drift + frontier + recent rows). Plain text —
 *  callers colorize. This is the "prior experience" a next round reads FIRST,
 *  with evidenceRefs kept verbatim so it can dereference raw traces next. */
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
