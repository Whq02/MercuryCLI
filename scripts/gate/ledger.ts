#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const LEDGER_PATH = 'scripts/gate/gate-ledger.jsonl'

export const CODE_TREE_EXCLUDED: readonly string[] = [LEDGER_PATH]

export const LEDGER_SCHEMA = 1 as const

export type ShardStatus = 'success' | 'failure' | 'missing' | 'duplicated'

export interface GateLedgerRow {
  schema: typeof LEDGER_SCHEMA
  recordedAt: string
  commit: string
  codeTree: string
  lockfileDigest: string
  toolchain: { node: string; bun: string }
  declaredToolchain: { node: string; bun: string }
  kind: 'local' | 'hosted' | 'windows-ui' | 'windows-functional' | 'windows-launcher'
  runId: string | null
  ok: boolean
  shardResults: Array<{ name: string; status: ShardStatus; durationSec?: number }>
  coveredRange: { from: string | null; to: string; commits: number }
}

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

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

export function declaredToolchain(rev = 'HEAD'): { node: string; bun: string } {
  let node = 'unknown'
  let bun = 'unknown'
  try {
    node = execFileSync('git', ['show', `${rev}:.node-version`], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
  } catch {
  }
  try {
    const gate = execFileSync('git', ['show', `${rev}:.github/workflows/gate.yml`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const m = gate.match(/bun-version:\s*(\d+\.\d+\.\d+)/) ?? gate.match(/bun-v(\d+\.\d+\.\d+)/)
    if (m) bun = m[1]!
  } catch {
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
  kind?: 'local' | 'hosted' | 'windows-ui' | 'windows-functional' | 'windows-launcher' | 'any'
  requireDeclaredToolchain?: boolean
}

export type EligibilityResult =
  | { eligible: true; row: GateLedgerRow; codeTree: string }
  | { eligible: false; reason: string; codeTree: string }

export function findVerdict(q: EligibilityQuery = {}): EligibilityResult {
  const rev = q.rev ?? 'HEAD'
  const kind = q.kind ?? 'any'
  const codeTree = computeCodeTree(rev)
  const lockfile = lockfileDigest(rev)
  const declared = declaredToolchain(rev)

  const rows = readLedger().filter(r => r.ok && r.codeTree === codeTree)
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
  kind: 'local' | 'hosted' | 'windows-ui' | 'windows-functional' | 'windows-launcher'
  runId?: string | null
  toolchain?: { node: string; bun: string }
}

export function rowFromVerdict(opts: RecordOptions): GateLedgerRow {
  const v = JSON.parse(readFileSync(opts.verdictPath, 'utf8')) as VerdictFile
  if (v.ok !== true) throw new Error('gate ledger: refusing to record a verdict that is not green')
  const commit = typeof v.headSha === 'string' ? v.headSha : ''
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('gate ledger: verdict has no resolvable headSha')
  }
  if (v.dirty === true) {
    throw new Error('gate ledger: refusing a verdict taken against a dirty tree')
  }
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
    runId: opts.runId ?? null,
    ok: true,
    shardResults: shardsFrom(v),
    coveredRange: { from: last?.commit ?? null, to: commit, commits },
  }
}


function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? 'show'
  try {
    if (cmd === 'record') {
      const kind = (arg('kind') ?? 'local') as 'local' | 'hosted' | 'windows-ui' | 'windows-functional' | 'windows-launcher'
      const verdictPath = arg('verdict')
      if (!verdictPath) throw new Error('gate ledger: --verdict <path> is required')
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
      console.log(
        `gate ledger: recorded ${row.kind} verdict for ${row.commit.slice(0, 12)} · codeTree ${row.codeTree.slice(0, 12)} · ${row.shardResults.length} suites · covers ${row.coveredRange.commits} commit(s)`,
      )
      process.exit(0)
    }

    if (cmd === 'check') {
      const res = findVerdict({
        rev: arg('rev') ?? 'HEAD',
        kind: (arg('kind') ?? 'any') as 'local' | 'hosted' | 'windows-ui' | 'windows-functional' | 'windows-launcher' | 'any',
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

    const rows = readLedger()
    const limit = Number(arg('limit') ?? 10)
    console.log(`gate ledger — ${rows.length} row(s) at ${LEDGER_PATH}`)
    for (const r of rows.slice(-limit)) {
      const red = r.shardResults.filter(s => s.status !== 'success').length
      console.log(
        `  ${r.recordedAt.slice(0, 19)}  ${r.kind.padEnd(6)}  ${r.commit.slice(0, 12)}  codeTree ${r.codeTree.slice(0, 12)}  ${r.shardResults.length} suites${red ? ` (${red} not green)` : ''}  covers ${r.coveredRange.commits}`,
      )
    }
    process.exit(0)
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    process.exit(2)
  }
}
