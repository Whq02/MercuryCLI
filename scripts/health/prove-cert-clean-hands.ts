#!/usr/bin/env bun
// prove-cert-clean-hands — the certificate keeps its hands off the verdict
// it writes (field card FC-070). Run one in a clean repo: it reported clean,
// wrote .mercury/doctor/last-cert.json untracked into the tree, and the
// NEXT identical run reported "uncommitted changes"; and because the state
// root was the bare cwd, a run from a subdirectory planted a SECOND
// .mercury estate there.
//
//   §1 getIsClean ignores exactly the doctor exhaust (other dirt still
//      reads dirty).
//   §2 the state root is the PROJECT root, not the bare cwd (call-shaped).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'clean-hands-home-')))
const REPO = realpathSync(mkdtempSync(join(tmpdir(), 'clean-hands-repo-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

execFileSync('git', ['init', '-q'], { cwd: REPO })
writeFileSync(join(REPO, 'a.txt'), 'tracked\n')
execFileSync('git', ['add', '.'], { cwd: REPO })
execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'], { cwd: REPO })
process.chdir(REPO)

const { getIsClean } = await import('../../src/utils/git.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

check('a clean repo reads clean', await getIsClean(), 'baseline')

// The product's own exhaust: must NOT flip the verdict.
mkdirSync(join(REPO, '.mercury', 'doctor'), { recursive: true })
writeFileSync(join(REPO, '.mercury', 'doctor', 'last-cert.json'), '{}')
check('the doctor exhaust alone still reads CLEAN (FC-070)', await getIsClean())

// Real dirt beside the exhaust: dirty.
writeFileSync(join(REPO, 'real-work.txt'), 'untracked work\n')
check('real untracked work still reads dirty', (await getIsClean()) === false)

const report = readFileSync(join(import.meta.dir, '../../src/utils/healthReport.ts'), 'utf8')
check(
  'the state root rides the PROJECT root, not the bare cwd (call-shaped)',
  /flagEnv\('MERCURY_DOCTOR_STATE_DIR'\) \|\| getProjectRootSafe\(\)/.test(report),
)

rmSync(HOME, { recursive: true, force: true })
rmSync(REPO, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-cert-clean-hands: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cert-clean-hands: all green')
