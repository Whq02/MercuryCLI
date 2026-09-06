#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ROOT, engineLaneState, renderReport, runParity, summarize } from './shell-engine-parity.ts'

const ENGINE_AWARE = ['scripts/bash/prove-shell-engine-exec.ts', 'scripts/bash/prove-shell-engine-rules.ts']
const OWNER_LEVEL = [
  'scripts/bash/prove-bash-permissions.ts',
  'scripts/bash/prove-glob-preamble.ts',
  'scripts/bash/prove-shell-cwd-record.ts',
  'scripts/bash/prove-output-tail-truth.ts',
  'scripts/bash/prove-shell-snapshot-path.ts',
  'scripts/bash/prove-shell-settlement.ts',
  'scripts/bash/prove-bash-tool-seams.ts',
  'scripts/decisions/prove-command-analysis.ts',
]

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const args = process.argv.slice(2)
const only: string[] = []
let all = false
let out: string | undefined
let shell: string | undefined
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string
  if (arg === '--only') only.push(args[++i] as string)
  else if (arg === '--all') all = true
  else if (arg === '--out') out = args[++i]
  else if (arg === '--shell') shell = args[++i]
}

const lane = engineLaneState()
if (shell === undefined && !(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) shell = '/bin/bash'

const enrolled = lane.state === 'wired' || all ? [...ENGINE_AWARE, ...OWNER_LEVEL] : ENGINE_AWARE
const chosen = only.length > 0 ? enrolled.filter(prover => only.includes(basename(prover))) : enrolled
const missing = chosen.filter(prover => !existsSync(join(ROOT, prover)))

console.log('============================================================')
console.log(' Shell-engine parity — the enrolled provers, twice each')
console.log('============================================================')
console.log(`  engine lane: ${lane.state} — ${lane.reason}`)
console.log(`  system lane shell: ${shell ?? process.env.SHELL ?? '(discovery)'}`)
if (lane.state !== 'wired') console.log('  [SKIP] the vendored engine is not exercised on this machine — the table below is system/system and proves the harness only')
check('every enrolled prover exists', missing.length === 0, missing.join(', '))
check('at least one prover is selected', chosen.length > 0, `--only ${only.join(',')}`)

if (chosen.length > 0) {
  const report = runParity(chosen, { out, shell, timeoutMs: 280_000 })
  for (const prover of report.provers) {
    check(`parity: ${summarize(prover)}`, prover.verdict === 'same')
    for (const row of prover.mismatches.slice(0, 20)) {
      console.log(`         ↳ ${row.label}: system ${row.system}${row.systemDetail ? ` (${row.systemDetail})` : ''} · brush ${row.brush}${row.brushDetail ? ` (${row.brushDetail})` : ''}`)
    }
    if (prover.exitMismatch) {
      const { system, brush } = prover.runs
      console.log(`         ↳ exit: system ${system.exit ?? system.signal} · brush ${brush.exit ?? brush.signal}`)
    }
  }
  const controlOnly = report.provers.filter(prover => prover.grade === 'control-only').map(prover => basename(prover.prover))
  if (controlOnly.length > 0) console.log(`  control-only (the harness, not the engine): ${controlOnly.join(', ')}`)
  check(`on a wired lane at least one enrolled prover exercised the engine (${report.exercised} of ${report.provers.length} carry the live-engine line)`, lane.state !== 'wired' || report.exercised > 0)
  console.log(`\n  report: ${report.reportPath}`)
  if (process.env.PARITY_PRINT_REPORT === '1') console.log(renderReport(report))
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ SHELL-ENGINE PARITY HOLDS')
else console.log(` ❌ ${failures} SHELL-ENGINE PARITY CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
