#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-gate-provenance.ts — the PROOFS gate row never
//  certifies repo-controlled data as Mercury's evidence (FC-150). A
//  hand-written .mercury/gate/verdict.json in a directory with no suites,
//  no machinery and no git used to read as a green gate.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-gate-provenance.ts
// ============================================================================
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'gate-prov-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'gate-prov-proj-')))
mkdirSync(join(SCRATCH, '.mercury', 'gate'), { recursive: true })
// The DECODER's own schema (healthCertCore.decodeGateVerdict) — the forger
// writes a schema-valid verdict, the card's stronger case.
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

const { setCwd } = await import('../../src/utils/Shell.js')
const { setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
setCwd(SCRATCH)
setOriginalCwd(SCRATCH)
setProjectRoot(SCRATCH)

const report = await import('../../src/utils/healthReport.js')
const cert = await report.runHealthReport({ depth: 'fast' })
const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'gate')
check(
  'a forged verdict in a gate-less project reads INFO naming the provenance, never a green gate',
  String(row?.status) === 'info' && String(row?.evidence).includes('NO gate') && String(row?.evidence).includes('project-authored'),
  `${row?.status}: ${String(row?.evidence).slice(0, 140)}`,
)
check('the forged suite count never rides the evidence', !String(row?.evidence).includes('12'))

rmSync(HOME, { recursive: true, force: true })
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-gate-provenance: all green' : `\nprove-gate-provenance: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
