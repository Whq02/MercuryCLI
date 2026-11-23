#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'gate-prov-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'gate-prov-proj-')))
mkdirSync(join(SCRATCH, '.mercury', 'gate'), { recursive: true })
writeFileSync(
  join(SCRATCH, '.mercury', 'gate', 'verdict.json'),
  JSON.stringify({
    ok: true,
    ranAt: new Date().toISOString(),
    pass: Array.from({ length: 12 }, (_, i) => `forged-suite-${i}`),
    fail: [],
    durationS: 400,
  }),
)

const { setCwd } = await import('../../src/platform/shell/shellExec.js')
const { setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.js')
setCwd(SCRATCH)
setOriginalCwd(SCRATCH)
setProjectRoot(SCRATCH)

const report = await import('../../src/platform/health/healthReport.js')
const cert = await report.runHealthReport({ depth: 'fast' })
const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'gate')
check(
  'a forged verdict in a gate-less project reads INFO naming the provenance, never a green gate',
  String(row?.status) === 'info' && String(row?.evidence).includes('NO gate') && String(row?.evidence).includes('project-authored'),
  `${row?.status}: ${String(row?.evidence).slice(0, 140)}`,
  'change the gate check in src/platform/health/sections/proofs.ts (proofsChecks) so a project without scripts/run-all-suites.sh returns status info with evidence naming NO gate and project-authored data',
)
check(
  'the forged suite count never rides the evidence',
  !String(row?.evidence).includes('12'),
  '',
  'change the gate check in src/platform/health/sections/proofs.ts (proofsChecks) so the info evidence for a gate-less project never carries the verdict suite count',
)

rmSync(HOME, { recursive: true, force: true })
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-gate-provenance: all green' : `\nprove-gate-provenance: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
