#!/usr/bin/env bun
// ============================================================================
//  scripts/gate/ledger.ts — THE GATE LEDGER.
//
//  The problem it replaces: gate verdicts lived in two places that both
//  forget. The hosted verdict is a workflow artifact with 30-day retention
//  that is never committed, and the local verdict is a single gitignored slot
//  that the next run overwrites. So "was this exact tree ever verified?" could
//  only be answered by a live `gh run list` against a window that expires, and
//  release eligibility was one string equality (tag ≡ package.json version)
//  that consulted no verdict at all.
//
//  This ledger is an APPEND-ONLY COMMITTED record of every full-gate verdict:
//  one JSON object per line at scripts/gate/gate-ledger.jsonl. It has no expiry, needs
//  no network, and travels with the repository.
//
//  ── The load-bearing detail: codeTree excludes the ledger ──────────────────
//  A verdict for tree T can only be RECORDED in a commit that comes after T,
//  and recording it changes the tree. Keyed on a plain tree hash, therefore,
//  no tree could ever match its own verdict — the record would be useless by
//  construction. `codeTree` is a digest over the commit's full file listing
//  with the ledger's own path filtered out, so appending a verdict row leaves
//  codeTree unchanged: verdict-row commits are ELIGIBILITY-NEUTRAL, and the
//  row can live inside the tag's own history.
//
//  That makes the release sequence honest and ordinary:
//      version bump + notes  →  dispatch the hosted gate  →  record the
//      verdict row  →  tag THAT commit (its codeTree equals the verified one).
//
//  Everything else that needs "is this tree verified?" reads the same key:
//  verify:fast's anchor resolution (which loses its live `gh` dependency),
//  the pre-push guard's sub-second fast path, and release eligibility.
//
//  A one-line source change or a lockfile-only change changes codeTree, so it
//  invalidates eligibility — which is the point.
// ============================================================================

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Committed, non-ignored, append-only. */
export const LEDGER_PATH = 'scripts/gate/gate-ledger.jsonl'

/**
 * Paths excluded from codeTree. EXACTLY the ledger — nothing else. Every
 * additional exclusion would be a hole through which an unverified change
 * could reach an eligible release, so this list stays a singleton and the
 * prover pins it.
 */
export const CODE_TREE_EXCLUDED: readonly string[] = [LEDGER_PATH]

export const LEDGER_SCHEMA = 1 as const

export type ShardStatus = 'success' | 'failure' | 'missing' | 'duplicated'

export type LedgerKind = 'local' | 'hosted' | 'hosted-drives' | 'windows-ui' | 'windows-functional' | 'windows-launcher'
export const LEDGER_KINDS: readonly LedgerKind[] = ['local', 'hosted', 'hosted-drives', 'windows-ui', 'windows-functional', 'windows-launcher']

/**
 * Kinds that REPORT and never VERIFY. A drives verdict says the real-terminal
 * suites drove green on a runner and nothing about the deterministic estate,
 * so it satisfies no eligibility query — however the query is asked, kind
 * 'any' included — and it is never the tag's verdict. Every reader of the
 * ledger that means "was this tree verified?" filters on this list.
 */
export const ADVISORY_KINDS: readonly LedgerKind[] = ['hosted-drives']
export const isAdvisoryKind = (kind: string): boolean => (ADVISORY_KINDS as readonly string[]).includes(kind)

/**
 * What a verdict covered: the release set (pure · cpu · exclusive), the
 * drives set (pty), or the whole estate as one pool. A verdict file without
 * the field is the whole estate (the local pool, older hosted rows).
 */
export type VerdictScope = 'release' | 'drives' | 'all'
export const VERDICT_SCOPES: readonly VerdictScope[] = ['release', 'drives', 'all']

export interface GateLedgerRow {
  schema: typeof LEDGER_SCHEMA
  recordedAt: string
  /** The commit the gate actually ran against. */
  commit: string
  /** Digest of the commit's file listing MINUS the ledger path. The key. */
  codeTree: string
  lockfileDigest: string
  /** What the verdict actually ran on. */
  toolchain: { node: string; bun: string }
  /** What the TREE pins — a hosted verdict must have run on these. */
  declaredToolchain: { node: string; bun: string }
  kind: LedgerKind
  /** The set the verdict covered; absent on rows recorded before the split. */
  scope?: VerdictScope
  /** The suites the verdict deliberately left to the other scope, by that scope's name. */
  deferred?: Record<string, string[]>
  runId: string | null
  ok: boolean
  shardResults: Array<{ name: string; status: ShardStatus; durationSec?: number }>
  /**
   * The commits this verdict newly covers: everything since the previous
   * ledger row's commit. An unverified stretch is visible as a long range at
   * the next dispatch — the ledger, not the push hook, is the record.
   */
  coveredRange: { from: string | null; to: string; commits: number }
}

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * The eligibility key: sha256 over the commit's sorted `git ls-tree -r`
 * listing with CODE_TREE_EXCLUDED paths removed. Derived from the COMMIT, so
 * uncommitted working-tree edits are deliberately invisible to it — a verdict
 * describes a commit, never a desk.
 */
export function computeCodeTree(rev = 'HEAD'): string {
  const raw = git(['ls-tree', '-r', '--full-tree', rev])
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .filter(line => {
      const tab = line.indexOf('\t')
      return tab === -1 || !CODE_TREE_EXCLUDED.includes(line.slice(tab + 1))
    })
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function lockfileDigest(rev = 'HEAD'): string {
  try {
    const raw = execFileSync('git', ['show', `${rev}:bun.lock`], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
    return createHash('sha256').update(raw).digest('hex')
  } catch {
    return 'absent'
  }
}

/** The toolchain the TREE pins: .node-version, and the bun the gate installs. */
export function declaredToolchain(rev = 'HEAD'): { node: string; bun: string } {
  let node = 'unknown'
  let bun = 'unknown'
  try {
    node = execFileSync('git', ['show', `${rev}:.node-version`], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
  } catch {
    /* unknown */
  }
  try {
    const gate = execFileSync('git', ['show', `${rev}:.github/workflows/gate.yml`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    // setup-bun declares the pin as `bun-version: X.Y.Z`; the `bun-vX.Y.Z`
    // cache-key spelling is the historical form — keep it as the fallback so
    // ledger rows minted against old revs still resolve (HZ9 #4;
    // before this, every row from a setup-bun tree recorded `bun: unknown`).
    const m = gate.match(/bun-version:\s*(\d+\.\d+\.\d+)/) ?? gate.match(/bun-v(\d+\.\d+\.\d+)/)
    if (m) bun = m[1]!
  } catch {
    /* unknown */
  }
  return { node, bun }
}

export function ledgerFile(): string {
  return join(ROOT, LEDGER_PATH)
}

export function readLedger(): GateLedgerRow[] {
  const file = ledgerFile()
  if (!existsSync(file)) return []
  const rows: GateLedgerRow[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed) as GateLedgerRow)
    } catch {
      // A malformed line is reported by the prover; it must never be silently
      // dropped into "no verdict exists", which would read as unverified.
      throw new Error(`gate ledger: malformed row — ${trimmed.slice(0, 120)}`)
    }
  }
  return rows
}

export function appendRow(row: GateLedgerRow): void {
  appendFileSync(ledgerFile(), `${JSON.stringify(row)}\n`)
}

export interface EligibilityQuery {
  rev?: string
  kind?: LedgerKind | 'any'
  /** Enforce that the verdict ran on the toolchain the tree pins. */
  requireDeclaredToolchain?: boolean
}

export type EligibilityResult =
  | { eligible: true; row: GateLedgerRow; codeTree: string }
  | { eligible: false; reason: string; codeTree: string }

/**
 * Is `rev` covered by a recorded green verdict? Matches on codeTree AND
 * lockfile digest; hosted queries additionally require the verdict to have run
 * on the toolchain the tree declares.
 */
export function findVerdict(q: EligibilityQuery = {}): EligibilityResult {
  const rev = q.rev ?? 'HEAD'
  const kind = q.kind ?? 'any'
  const codeTree = computeCodeTree(rev)
  const lockfile = lockfileDigest(rev)
  const declared = declaredToolchain(rev)

  if (kind !== 'any' && isAdvisoryKind(kind)) {
    return { eligible: false, reason: `a "${kind}" verdict is advisory — it reports the drives and verifies nothing`, codeTree }
  }
  // An advisory row never verifies, whichever kind the query asks for.
  const rows = readLedger().filter(r => r.ok && r.codeTree === codeTree && !isAdvisoryKind(r.kind))
  if (rows.length === 0) {
    return { eligible: false, reason: 'no green verdict recorded for this codeTree', codeTree }
  }
  const byKind = kind === 'any' ? rows : rows.filter(r => r.kind === kind)
  if (byKind.length === 0) {
    return {
      eligible: false,
      reason: `a green verdict exists for this codeTree but none of kind "${kind}" (found: ${[...new Set(rows.map(r => r.kind))].join(', ')})`,
      codeTree,
    }
  }
  const byLock = byKind.filter(r => r.lockfileDigest === lockfile)
  if (byLock.length === 0) {
    return {
      eligible: false,
      reason: 'the recorded verdict was taken against a different lockfile digest',
      codeTree,
    }
  }
  if (q.requireDeclaredToolchain) {
    const ok = byLock.filter(
      r =>
        (r.toolchain.node === declared.node ||
          r.toolchain.node === `v${declared.node}`) &&
        r.toolchain.bun === declared.bun,
    )
    if (ok.length === 0) {
      const seen = byLock.map(r => `${r.toolchain.node}/${r.toolchain.bun}`).join(', ')
      return {
        eligible: false,
        reason: `the recorded verdict did not run on the toolchain this tree pins (node ${declared.node}, bun ${declared.bun}; recorded: ${seen})`,
        codeTree,
      }
    }
    return { eligible: true, row: ok[ok.length - 1]!, codeTree }
  }
  return { eligible: true, row: byLock[byLock.length - 1]!, codeTree }
}

// ── verdict-file adapters ───────────────────────────────────────────────────

interface VerdictFile {
  ok?: unknown
  pass?: unknown
  fail?: unknown
  headSha?: unknown
  treeSha?: unknown
  dirty?: unknown
  durations?: Record<string, number>
  missing?: unknown
  duplicated?: unknown
  scope?: unknown
  deferred?: unknown
}

function shardsFrom(v: VerdictFile): GateLedgerRow['shardResults'] {
  const out: GateLedgerRow['shardResults'] = []
  const durations = v.durations ?? {}
  for (const name of (Array.isArray(v.pass) ? v.pass : []) as string[]) {
    out.push({ name, status: 'success', ...(durations[name] !== undefined && { durationSec: durations[name] }) })
  }
  for (const name of (Array.isArray(v.fail) ? v.fail : []) as string[]) {
    out.push({ name, status: 'failure', ...(durations[name] !== undefined && { durationSec: durations[name] }) })
  }
  for (const name of (Array.isArray(v.missing) ? v.missing : []) as string[]) {
    out.push({ name, status: 'missing' })
  }
  for (const name of (Array.isArray(v.duplicated) ? v.duplicated : []) as string[]) {
    out.push({ name, status: 'duplicated' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface RecordOptions {
  verdictPath: string
  kind: LedgerKind
  runId?: string | null
  /** Observed toolchain; defaults to this process's node + bun. */
  toolchain?: { node: string; bun: string }
}

/** Build a row from a verdict file, refusing anything that cannot be bound. */
export function rowFromVerdict(opts: RecordOptions): GateLedgerRow {
  const v = JSON.parse(readFileSync(opts.verdictPath, 'utf8')) as VerdictFile
  if (v.ok !== true) throw new Error('gate ledger: refusing to record a verdict that is not green')
  // THE SCOPE LAW: a drives-scope verdict is a report, never the release
  // verdict — it records only as the advisory kind, and the advisory kind
  // records nothing else. A release-scope verdict (ok over the deterministic
  // set, the drives deferred) is what `--kind hosted` carries after the split.
  const scope: VerdictScope = v.scope === undefined ? 'all' : (v.scope as VerdictScope)
  if (!VERDICT_SCOPES.includes(scope)) {
    throw new Error(`gate ledger: verdict scope "${String(v.scope)}" is not release|drives|all`)
  }
  if (opts.kind === 'hosted-drives' && scope !== 'drives') {
    throw new Error(`gate ledger: --kind hosted-drives records a drives-scope verdict; this one is scope "${scope}"`)
  }
  if (opts.kind !== 'hosted-drives' && scope === 'drives') {
    throw new Error('gate ledger: a drives-scope verdict is a report, never the release verdict — record it with --kind hosted-drives')
  }
  const deferred =
    v.deferred !== null && typeof v.deferred === 'object' && !Array.isArray(v.deferred)
      ? (v.deferred as Record<string, string[]>)
      : undefined
  const commit = typeof v.headSha === 'string' ? v.headSha : ''
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('gate ledger: verdict has no resolvable headSha')
  }
  if (v.dirty === true) {
    throw new Error('gate ledger: refusing a verdict taken against a dirty tree')
  }
  // A local verdict binds the WORKING content tree; it may only be recorded
  // when that content is exactly the commit's own tree, or the row would
  // claim coverage the commit never had.
  if (typeof v.treeSha === 'string') {
    const commitTree = git(['rev-parse', `${commit}^{tree}`]).trim()
    if (v.treeSha !== commitTree) {
      throw new Error(
        `gate ledger: the verdict's content tree (${v.treeSha.slice(0, 12)}) is not the commit's tree (${commitTree.slice(0, 12)}) — commit the verified content first`,
      )
    }
  }

  const previous = readLedger().filter(r => r.ok)
  const last = previous[previous.length - 1] ?? null
  let commits = 0
  if (last) {
    try {
      commits = Number(git(['rev-list', '--count', `${last.commit}..${commit}`]).trim())
    } catch {
      commits = 0
    }
  }

  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version ?? 'unknown'
  return {
    schema: LEDGER_SCHEMA,
    recordedAt: new Date().toISOString(),
    commit,
    codeTree: computeCodeTree(commit),
    lockfileDigest: lockfileDigest(commit),
    toolchain: opts.toolchain ?? { node: process.version, bun: bunVersion },
    declaredToolchain: declaredToolchain(commit),
    kind: opts.kind,
    scope,
    ...(deferred !== undefined && { deferred }),
    runId: opts.runId ?? null,
    ok: true,
    shardResults: shardsFrom(v),
    coveredRange: { from: last?.commit ?? null, to: commit, commits },
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? 'show'
  try {
    if (cmd === 'record') {
      const kind = (arg('kind') ?? 'local') as LedgerKind
      if (!LEDGER_KINDS.includes(kind)) throw new Error(`gate ledger: --kind wants ${LEDGER_KINDS.join('|')} (got "${kind}")`)
      const verdictPath = arg('verdict')
      if (!verdictPath) throw new Error('gate ledger: --verdict <path> is required')
      // --toolchain vNODE/BUN: the toolchain the verdict's SUITES ran on,
      // taken from run evidence (the gate's calibration-pin step receipts).
      // Required in practice for hosted rows recorded from a bystander
      // machine: the default below observes the RECORDER's process, and under
      // `bun run` process.version is bun's EMULATED node — a release-floor run
      // once refused a row stamped that way while the run itself was on
      // the pin.
      const tc = arg('toolchain')
      let toolchain: { node: string; bun: string } | undefined
      if (tc) {
        const [tcNode, tcBun] = tc.split('/')
        if (!tcNode || !tcBun) throw new Error('gate ledger: --toolchain wants <node>/<bun>, e.g. v24.18.0/1.3.11')
        toolchain = { node: tcNode, bun: tcBun }
      }
      const row = rowFromVerdict({ verdictPath, kind, runId: arg('run-id') ?? null, toolchain })
      const existing = readLedger()
      if (existing.some(r => r.commit === row.commit && r.kind === row.kind && r.runId === row.runId)) {
        console.log(`gate ledger: row already present for ${row.commit.slice(0, 12)} (${row.kind})`)
        process.exit(0)
      }
      appendRow(row)
      const deferredNote = row.deferred ? ` · deferred ${Object.entries(row.deferred).map(([k, v]) => `${v.length} to ${k}`).join(', ')}` : ''
      console.log(
        `gate ledger: recorded ${row.kind} verdict (${row.scope ?? 'all'} scope) for ${row.commit.slice(0, 12)} · codeTree ${row.codeTree.slice(0, 12)} · ${row.shardResults.length} suites${deferredNote} · covers ${row.coveredRange.commits} commit(s)`,
      )
      process.exit(0)
    }

    if (cmd === 'check') {
      const res = findVerdict({
        rev: arg('rev') ?? 'HEAD',
        kind: (arg('kind') ?? 'any') as LedgerKind | 'any',
        requireDeclaredToolchain: process.argv.includes('--require-toolchain'),
      })
      if (res.eligible) {
        console.log(
          `✅ verified: ${res.row.kind} verdict ${res.row.runId ?? '(local)'} at ${res.row.commit.slice(0, 12)} · codeTree ${res.codeTree.slice(0, 12)}`,
        )
        process.exit(0)
      }
      console.log(`❌ unverified: ${res.reason} · codeTree ${res.codeTree.slice(0, 12)}`)
      process.exit(1)
    }

    if (cmd === 'code-tree') {
      console.log(computeCodeTree(arg('rev') ?? 'HEAD'))
      process.exit(0)
    }

    // show
    const rows = readLedger()
    const limit = Number(arg('limit') ?? 10)
    console.log(`gate ledger — ${rows.length} row(s) at ${LEDGER_PATH}`)
    for (const r of rows.slice(-limit)) {
      const red = r.shardResults.filter(s => s.status !== 'success').length
      console.log(
        `  ${r.recordedAt.slice(0, 19)}  ${r.kind.padEnd(13)}  ${(r.scope ?? 'all').padEnd(7)}  ${r.commit.slice(0, 12)}  codeTree ${r.codeTree.slice(0, 12)}  ${r.shardResults.length} suites${red ? ` (${red} not green)` : ''}  covers ${r.coveredRange.commits}`,
      )
    }
    process.exit(0)
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    process.exit(2)
  }
}
