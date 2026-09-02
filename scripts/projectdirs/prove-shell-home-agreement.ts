#!/usr/bin/env bun
// ============================================================================
//  scripts/projectdirs/prove-shell-home-agreement.ts — the SHELL twin
//  (scripts/lib/project-home.sh project_store_dir) resolves BYTE-IDENTICAL to
//  the TS seam (adoptiveProjectPath) on every home shape.
//
//  Without this pin the two implementations drift silently the first time
//  someone edits one side — the symptom is the doctor CERT chip quietly
//  reading a stale verdict forever. Hermetic: mkdtemp fixtures; env pinned.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptiveProjectPath } from '../../src/utils/projectStoreAdoption.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HELPER = join(import.meta.dir, '..', 'lib', 'project-home.sh')
const shellResolve = (root: string, name: string): string =>
  execFileSync('bash', ['-c', `. ${JSON.stringify(HELPER)} && project_store_dir ${JSON.stringify(root)} ${JSON.stringify(name)}`], {
    encoding: 'utf8',
  })

const scratch = mkdtempSync(join(tmpdir(), 'shell-home-agree-'))
const shapes: Array<[string, string[]]> = [
  ['fresh (no homes)', []],
  ['.claude only', ['.claude/gate']],
  ['.mercury present', ['.mercury/gate', '.claude/gate']],
]

console.log('============================================================')
console.log(' shell↔TS store-home agreement — byte-identical on every shape')
console.log('============================================================')
for (const [label, dirs] of shapes) {
  const root = join(scratch, label.replace(/[^a-z]+/gi, '-'))
  mkdirSync(root, { recursive: true })
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true })
  // Separator-normalize both sides: the TS resolver joins
  // with the platform separator, the shell side always speaks '/'.
  const ts = adoptiveProjectPath(root, 'gate').replaceAll('\\', '/')
  const sh = shellResolve(root, 'gate').replaceAll('\\', '/')
  check(`${label}: shell === TS`, ts === sh, `ts=${ts} sh=${sh}`)
}

rmSync(scratch, { recursive: true, force: true })
console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} agreement check(s) failed`)
  process.exit(1)
}
console.log('✅ SHELL AND TS RESOLVE THE SAME STORE HOME')
