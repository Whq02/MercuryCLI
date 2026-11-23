#!/usr/bin/env bun

;(globalThis as any).MACRO = {
  VERSION: '2.1.0',
  ISSUES_EXPLAINER: 'x',
  PACKAGE_URL: 'x',
  README_URL: 'x',
  VERSION_TAG: 'x',
}

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'commit-gate-home-'))
process.env.MERCURY_CONFIG_DIR = ISOLATED_HOME
process.env.MERCURY_HOME = ISOLATED_HOME
const REPOSITORY = realpathSync(mkdtempSync(join(tmpdir(), 'commit-gate-repository-')))
execFileSync('git', ['init', '-q', REPOSITORY], { stdio: 'pipe' })
process.chdir(REPOSITORY)
const { getMercuryHome } = await import('../../src/platform/environment/envUtils.js')
const { sanitizePath } = await import('../../src/sessions/transcripts/sessionStoragePortable.js')
const { getCwd } = await import('../../src/platform/files/cwd.js')
for (const driveCwd of new Set([getCwd(), process.cwd(), realpathSync(process.cwd())])) {
  const verifyDir = join(getMercuryHome(), 'verify', sanitizePath(driveCwd))
  mkdirSync(verifyDir, { recursive: true })
  writeFileSync(join(verifyDir, 'evidence.json'), JSON.stringify({ schema: 1, records: [] }))
}

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Standalone commit gate (Feature B) — behavior proof')
console.log('============================================================')

const fh = await import('../../src/permissions/guards/commitGate.js')
const { guardsEngaged, judgeToolCall } = await import('../../src/permissions/guards/guards.js')
const cg = await import('../../src/permissions/guards/commitGate.js')

const sid = 'proof-commit-gate'
const ENGAGE_HINT = 'check commitGateEnabled, engageCommitGate, isCommitGateEngaged and disengageCommitGate in src/permissions/guards/commitGate.ts'
const JUDGE_HINT = 'check the deny and allow rules of evaluateCommitGate in src/permissions/guards/commitGate.ts and how judgeToolCall in src/permissions/guards/guards.ts applies the engaged gate'
const RULE_HINT = 'check the rules of evaluateCommitGate in src/permissions/guards/commitGate.ts for this command'
const SHIP_HINT = 'run bun run build.ts so dist/mercury.mjs carries the wired gate from src/permissions/guards/commitGate.ts'
const gateEngaged = (): boolean => guardsEngaged(sid).tool.includes(cg.COMMIT_GATE_ID)
const judge = async (tool: string, command: string): Promise<boolean> => {
  const verdict = await judgeToolCall(sid, { tool, input: { command }, callId: 'commit-gate-call', messages: [] })
  return !verdict.refused
}


section('default-OFF gate truth table (DEFAULT-OFF, opt in MERCURY_COMMIT_GATE=1)')
{
  delete process.env.MERCURY_COMMIT_GATE
  check('OFF (no flag): commitGateEnabled() === false', fh.commitGateEnabled() === false, '', ENGAGE_HINT)
  check('OFF: engageCommitGate is a no-op (returns false, no throw)', fh.engageCommitGate(sid) === false, '', ENGAGE_HINT)
  check('OFF: nothing registered (byte-identical — no gate)', gateEngaged() === false, '', ENGAGE_HINT)

  process.env.MERCURY_COMMIT_GATE = '1'
  check('ON (MERCURY_COMMIT_GATE=1): commitGateEnabled() === true', fh.commitGateEnabled() === true, '', ENGAGE_HINT)
}

section('engage installs the Bash guard (no ReferenceError — the original crash is fixed)')
{
  const installed = fh.engageCommitGate(sid)
  check('engageCommitGate returned true (installed)', installed === true, '', ENGAGE_HINT)
  check('isCommitGateEngaged(sid) === true (session-keyed guards)', fh.isCommitGateEngaged(sid) === true, '', ENGAGE_HINT)
  check('the gate is engaged before the session\'s tool calls under COMMIT_GATE_ID', gateEngaged(), '', ENGAGE_HINT)
  check('re-engage is idempotent (no second install)', fh.engageCommitGate(sid) === false && guardsEngaged(sid).tool.filter(id => id === cg.COMMIT_GATE_ID).length === 1, '', ENGAGE_HINT)
}

section('the installed gate DENIES a non-green commit and ALLOWS a green-gated one')
{
  if (!gateEngaged()) {
    check('gate present to drive', false, '', ENGAGE_HINT)
  } else {
    const allowed = async (cmd: string) => judge('Bash', cmd)
    check('bare `git commit -m "wip"` is DENIED (the gate refuses)', (await allowed('git commit -m "wip"')) === false, '', JUDGE_HINT)
    check('`git commit --no-verify` is DENIED', (await allowed('git commit --no-verify -m "skip"')) === false, '', JUDGE_HINT)
    check('a green-gated `bun run build.ts && git commit` is ALLOWED', (await allowed('bun run build.ts && git commit -m "done"')) === true, '', JUDGE_HINT)
    check('the canonical `bash scripts/run-all-suites.sh && git commit` is ALLOWED', (await allowed('bash scripts/run-all-suites.sh && git commit -m "x"')) === true, '', JUDGE_HINT)
    check('a non-commit Bash command passes straight through', (await allowed('ls -la')) === true, '', JUDGE_HINT)
    const allowedPS = async (cmd: string) => judge('PowerShell', cmd)
    check('PowerShell-tool bare `git commit` is DENIED (HB-0130)', (await allowedPS('git commit -m "wip"')) === false, '', JUDGE_HINT)
    check('PowerShell-tool green-gated commit is ALLOWED', (await allowedPS('bun run build.ts && git commit -m "ok"')) === true, '', JUDGE_HINT)
  }
}

section("the gate judges in a repository this proof made, whatever is staged in the tree it was started from")
{
  const read = cg.commitRepositoryRoot('git commit -m "x"', getCwd())
  check("the session's folder is this proof's own repository, and it is the one a commit there is read in", getCwd() === REPOSITORY && read === REPOSITORY, `folder ${getCwd()} · read ${read}`, 'commitRepositoryRoot in src/permissions/guards/commitGate.ts must resolve the repository from the session folder given to it')
  writeFileSync(join(REPOSITORY, 'staged.ts'), 'export const staged = 1\n')
  execFileSync('git', ['add', 'staged.ts'], { cwd: REPOSITORY, stdio: 'pipe' })
  check('with a file staged there a green-gated commit is still ALLOWED and a bare one still DENIED', (await judge('Bash', 'bun run build.ts && git commit -m "done"')) === true && (await judge('Bash', 'git commit -m "wip"')) === false, '', JUDGE_HINT)
}

section('disengage removes the gate (no leak)')
{
  check('disengageCommitGate returned true', fh.disengageCommitGate(sid) === true, '', ENGAGE_HINT)
  check('isCommitGateEngaged(sid) === false after disengage', fh.isCommitGateEngaged(sid) === false, '', ENGAGE_HINT)
  check('the gate is gone', gateEngaged() === false, '', ENGAGE_HINT)
}

section("pure evaluateCommitGate — the gate's deny rules (loadable, exported)")
{
  check('bare commit → bare-commit deny', cg.evaluateCommitGate('git commit -m "x"').allow === false && cg.evaluateCommitGate('git commit -m "x"').rule === 'bare-commit', '', RULE_HINT)
  check('--no-verify → no-verify-flag deny', cg.evaluateCommitGate('npm test && git commit --no-verify -m "x"').allow === false, '', RULE_HINT)
  check('chained verify → chained-verify allow', cg.evaluateCommitGate('npm test && git commit -m "x"').rule === 'chained-verify', '', RULE_HINT)
  check('no commit at all → not-a-commit allow', cg.evaluateCommitGate('echo hi').allow === true, '', RULE_HINT)
  check('a commit MESSAGE containing "test" does NOT satisfy the gate', cg.evaluateCommitGate('git commit -m "add a test"').allow === false, '', RULE_HINT)
  check('no-op head `echo pytest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('echo pytest && git commit -m "x"').allow === false, '', RULE_HINT)
  check('no-op head `true vitest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('true vitest && git commit -m "x"').allow === false, '', RULE_HINT)
  check('no-op head `: green-gate && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate(': green-gate && git commit -m "x"').allow === false, '', RULE_HINT)
  check('no-op head `test -f x && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('test -f x && git commit -m "x"').allow === false, '', RULE_HINT)
  check('real verify `pytest && git commit` is ALLOWED', cg.evaluateCommitGate('pytest && git commit -m "x"').allow === true, '', RULE_HINT)
  check('env-prefixed real verify `FOO=1 pytest && git commit` is ALLOWED', cg.evaluateCommitGate('FOO=1 pytest && git commit -m "x"').allow === true, '', RULE_HINT)

  check('`npm --prefix tools/x test -- --run && git commit` is ALLOWED (the AVS literal)',
    cg.evaluateCommitGate('node --check a.js && npm --prefix tools/azgaar-avs test -- --run && git commit -m "x"').allow === true, '', RULE_HINT)
  check('`pnpm -C pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('pnpm -C pkg test && git commit -m "x"').allow === true, '', RULE_HINT)
  check('`yarn --cwd pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('yarn --cwd pkg test && git commit -m "x"').allow === true, '', RULE_HINT)
  check('`npm -w app run build && git commit` is ALLOWED', cg.evaluateCommitGate('npm -w app run build && git commit -m "x"').allow === true, '', RULE_HINT)
  check('piped verify `npm test | tail -5 && git commit` stays DENIED', cg.evaluateCommitGate('npm test | tail -5 && git commit -m "x"').allow === false, '', RULE_HINT)
  check('subshell verify `(cd pkg && npm test) && git commit` is ALLOWED', cg.evaluateCommitGate('(cd pkg && npm test) && git commit -m "x"').allow === true, '', RULE_HINT)
  check('`npm --prefix` with no verb stays DENIED', cg.evaluateCommitGate('npm --prefix tools/x && git commit -m "x"').allow === false, '', RULE_HINT)
}


section('dist: the wired standalone gate ships in dist/mercury.mjs')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the opt-in flag ships', present('MERCURY_COMMIT_GATE'), '', SHIP_HINT)
    check('the commit-gate engage log ships', present('[commit-gate] engaged for session'), '', SHIP_HINT)
    check('the commit-gate reprompt ships', present('Commit gate: this commit is not verified'), '', SHIP_HINT)
  }
}

process.chdir(tmpdir())
rmSync(REPOSITORY, { recursive: true, force: true })
rmSync(ISOLATED_HOME, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL COMMIT-GATE PROOFS PASS')
else console.log(`❌ ${failures} COMMIT-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
