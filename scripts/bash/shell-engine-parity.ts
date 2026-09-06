#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { brushPackPlatform } from '../../src/utils/shell/brushPack.ts'

export const ENGINES = ['system', 'brush'] as const
export type Engine = (typeof ENGINES)[number]
export const ENGINE_ENV = 'MERCURY_SHELL_ENGINE'

export const ROOT: string = resolve(import.meta.dir, '..', '..')
const BUN = process.env.BUN ?? process.execPath

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP'
export interface Check {
  status: CheckStatus
  label: string
  detail: string
  ordinal: number
}
export interface ProverRun {
  engine: Engine
  prover: string
  exit: number | null
  signal: string | null
  ms: number
  stdout: string
  stderr: string
  checks: Check[]
}
export type SideStatus = CheckStatus | 'absent'
export const LIVE_ENGINE_LINE = /the shell that answered: brush/
export type EngineGrade = 'exercised' | 'control-only'
export interface ParityRow {
  key: string
  label: string
  system: SideStatus
  brush: SideStatus
  systemDetail: string
  brushDetail: string
  verdict: 'same' | 'mismatch'
}
export interface ProverParity {
  prover: string
  runs: Record<Engine, ProverRun>
  rows: ParityRow[]
  mismatches: ParityRow[]
  exitMismatch: boolean
  verdict: 'same' | 'mismatch'
  grade: EngineGrade
}
export type LaneState = { state: 'wired' | 'unwired'; reason: string; pack: string | null }
export interface ParityReport {
  lane: LaneState
  shell: string | null
  provers: ProverParity[]
  verdict: 'same' | 'mismatch'
  exercised: number
  reportPath: string | null
}
export interface RunOptions {
  shell?: string
  timeoutMs?: number
  cwd?: string
}


export function findVendoredBrush(root: string = ROOT): string | null {
  const packRoot = join(root, 'vendor', 'brush')
  if (!existsSync(packRoot)) return null
  const names = new Set(['brush', 'brush.exe'])
  const host = brushPackPlatform()
  if (host !== null) {
    for (const bin of ['brush', 'brush.exe']) {
      const p = join(packRoot, host, bin)
      if (existsSync(p)) return p
    }
  }
  const stack: string[] = [packRoot]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      if (names.has(entry)) return full
      try {
        if (readdirSync(full).length >= 0) stack.push(full)
      } catch {
      }
    }
  }
  return null
}

export function engineLaneState(root: string = ROOT): LaneState {
  const registry = join(root, 'src', 'substrate', 'flagRegistry.ts')
  const text = existsSync(registry) ? readFileSync(registry, 'utf8') : ''
  if (!text.includes(`'${ENGINE_ENV}'`)) {
    return {
      state: 'unwired',
      reason: `${ENGINE_ENV} has no flag-registry row in this tree: the engine lane is not wired, so a "brush" run is a system run`,
      pack: null,
    }
  }
  const pack = findVendoredBrush(root)
  if (pack === null) {
    return {
      state: 'unwired',
      reason: `${ENGINE_ENV} is registered but vendor/brush carries no binary for this machine: the setting refuses to arm, so a "brush" run is a system run`,
      pack: null,
    }
  }
  return { state: 'wired', reason: `${ENGINE_ENV} is registered and the pack is present (${relative(root, pack)})`, pack }
}

export function resolveEngineUnderTest(env: NodeJS.ProcessEnv = process.env, root: string = ROOT): Engine {
  if (env[ENGINE_ENV] !== 'brush') return 'system'
  return engineLaneState(root).state === 'wired' ? 'brush' : 'system'
}


const BRACKETED = /^\s*\[(PASS|FAIL|SKIP)\]\s*(.*?)\s*$/
const BARE = /^(PASS|FAIL|SKIP)\s{2,}(.*?)\s*$/
const DETAIL_SEPARATOR = ' — '

export function parseChecks(text: string): Check[] {
  const checks: Check[] = []
  const seen = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const match = BRACKETED.exec(line) ?? BARE.exec(line)
    if (!match) continue
    const status = match[1] as CheckStatus
    const rest = match[2] ?? ''
    const split = rest.indexOf(DETAIL_SEPARATOR)
    const label = split === -1 ? rest : rest.slice(0, split)
    const detail = split === -1 ? '' : rest.slice(split + DETAIL_SEPARATOR.length)
    const ordinal = (seen.get(label) ?? 0) + 1
    seen.set(label, ordinal)
    checks.push({ status, label, detail, ordinal })
  }
  return checks
}


export function runProver(prover: string, engine: Engine, options: RunOptions = {}): ProverRun {
  const path = isAbsolute(prover) ? prover : join(ROOT, prover)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [ENGINE_ENV]: engine,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
  }
  if (options.shell) env.SHELL = options.shell
  const started = Date.now()
  const result = spawnSync(BUN, ['run', path], {
    cwd: options.cwd ?? ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? (result.error ? String(result.error) : '')
  return {
    engine,
    prover: relative(ROOT, path),
    exit: result.status,
    signal: result.signal ?? null,
    ms: Date.now() - started,
    stdout,
    stderr,
    checks: parseChecks(stdout),
  }
}


const keyOf = (check: Check): string => `${check.label}#${check.ordinal}`

export function pairRuns(system: ProverRun, brush: ProverRun): ParityRow[] {
  const bySystem = new Map(system.checks.map(check => [keyOf(check), check]))
  const byBrush = new Map(brush.checks.map(check => [keyOf(check), check]))
  const order: string[] = []
  const known = new Set<string>()
  for (const check of [...system.checks, ...brush.checks]) {
    const key = keyOf(check)
    if (known.has(key)) continue
    known.add(key)
    order.push(key)
  }
  return order.map(key => {
    const left = bySystem.get(key)
    const right = byBrush.get(key)
    const systemStatus: SideStatus = left?.status ?? 'absent'
    const brushStatus: SideStatus = right?.status ?? 'absent'
    return {
      key,
      label: (left ?? right)?.label ?? key,
      system: systemStatus,
      brush: brushStatus,
      systemDetail: left?.detail ?? '',
      brushDetail: right?.detail ?? '',
      verdict: systemStatus === brushStatus ? 'same' : 'mismatch',
    }
  })
}

export function compareProver(prover: string, options: RunOptions = {}): ProverParity {
  const system = runProver(prover, 'system', options)
  const brush = runProver(prover, 'brush', options)
  const rows = pairRuns(system, brush)
  const mismatches = rows.filter(row => row.verdict === 'mismatch')
  const exitMismatch = system.exit !== brush.exit || system.signal !== brush.signal
  return {
    prover: system.prover,
    runs: { system, brush },
    rows,
    mismatches,
    exitMismatch,
    verdict: mismatches.length === 0 && !exitMismatch ? 'same' : 'mismatch',
    grade: LIVE_ENGINE_LINE.test(brush.stdout) ? 'exercised' : 'control-only',
  }
}

export function runParity(provers: readonly string[], options: RunOptions & { out?: string } = {}): ParityReport {
  const lane = engineLaneState()
  const results = provers.map(prover => compareProver(prover, options))
  const report: ParityReport = {
    lane,
    shell: options.shell ?? null,
    provers: results,
    verdict: results.every(result => result.verdict === 'same') ? 'same' : 'mismatch',
    exercised: results.filter(result => result.grade === 'exercised').length,
    reportPath: null,
  }
  report.reportPath = writeReport(report, options.out)
  return report
}


const tail = (text: string, lines = 30): string =>
  text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .slice(-lines)
    .join('\n')

export function renderReport(report: ParityReport): string {
  const out: string[] = []
  out.push('# Shell-engine parity report', '')
  out.push(`- engine lane: **${report.lane.state}** — ${report.lane.reason}`)
  out.push(`- system lane shell: ${report.shell ?? 'the inherited SHELL (the product\'s own discovery)'}`)
  out.push(`- verdict: **${report.verdict}**`)
  out.push(`- engine exercised by ${report.exercised} of ${report.provers.length} provers (the rest are control-only: no live-engine line in their brush run — both runs executed the same code)`, '')
  for (const prover of report.provers) {
    const { system, brush } = prover.runs
    out.push(`## ${prover.prover} — ${prover.verdict} (${prover.grade})`, '')
    out.push(
      `- system: exit ${system.exit ?? `signal ${system.signal}`} in ${(system.ms / 1000).toFixed(1)}s, ${system.checks.length} checks`,
    )
    out.push(
      `- brush: exit ${brush.exit ?? `signal ${brush.signal}`} in ${(brush.ms / 1000).toFixed(1)}s, ${brush.checks.length} checks`,
    )
    if (prover.exitMismatch) out.push(`- **exit mismatch**: the two runs ended differently`)
    out.push('', '| check | system | brush | verdict |', '|---|---|---|---|')
    for (const row of prover.rows) {
      out.push(`| ${row.label.replace(/\|/g, '\\|')} | ${row.system} | ${row.brush} | ${row.verdict} |`)
    }
    out.push('')
    if (prover.mismatches.length > 0) {
      out.push('### Mismatches', '')
      for (const row of prover.mismatches) {
        out.push(`- **${row.label}** — system ${row.system}${row.systemDetail ? ` (${row.systemDetail})` : ''} · brush ${row.brush}${row.brushDetail ? ` (${row.brushDetail})` : ''}`)
      }
      out.push('')
    }
    if (prover.exitMismatch || prover.mismatches.length > 0) {
      out.push('### Run tails', '', '```text', `--- system (exit ${system.exit})`, tail(system.stdout + '\n' + system.stderr), '', `--- brush (exit ${brush.exit})`, tail(brush.stdout + '\n' + brush.stderr), '```', '')
    }
  }
  return out.join('\n')
}

function writeReport(report: ParityReport, out?: string): string {
  const path = out ?? join(tmpdir(), 'shell-engine-parity', `${Date.now()}.md`)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, renderReport({ ...report, reportPath: path }))
  return path
}

export function summarize(prover: ProverParity): string {
  const { system, brush } = prover.runs
  const head = `${prover.prover}: ${prover.verdict}, ${prover.grade} — ${prover.rows.length} checks, ${prover.mismatches.length} mismatches${prover.exitMismatch ? ', exit mismatch' : ''} (system ${(system.ms / 1000).toFixed(1)}s · brush ${(brush.ms / 1000).toFixed(1)}s)`
  if (prover.mismatches.length === 0) return head
  const named = prover.mismatches
    .slice(0, 5)
    .map(row => `${row.label} [system ${row.system} · brush ${row.brush}]`)
    .join('; ')
  return `${head}: ${named}`
}


if (import.meta.main) {
  const args = process.argv.slice(2)
  const provers: string[] = []
  let out: string | undefined
  let shell: string | undefined
  let timeoutMs: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--out') out = args[++i]
    else if (arg === '--shell') shell = args[++i]
    else if (arg === '--timeout-ms') timeoutMs = Number(args[++i])
    else provers.push(arg)
  }
  if (provers.length === 0) {
    console.error('usage: shell-engine-parity.ts [--out <file>] [--shell <path>] [--timeout-ms <n>] <prover.ts>…')
    process.exit(2)
  }
  const report = runParity(provers, { out, shell, timeoutMs })
  console.log(`engine lane: ${report.lane.state} — ${report.lane.reason}`)
  for (const prover of report.provers) console.log(`  ${summarize(prover)}`)
  console.log(`engine exercised by ${report.exercised} of ${report.provers.length} provers`)
  console.log(`report: ${report.reportPath}`)
  console.log(`verdict: ${report.verdict}`)
  process.exit(report.verdict === 'same' ? 0 : 1)
}
