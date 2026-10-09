#!/usr/bin/env bun

;(globalThis as any).MACRO = {
  VERSION: '2.1.0',
  ISSUES_EXPLAINER: 'x',
  PACKAGE_URL: 'x',
  README_URL: 'x',
  VERSION_TAG: 'x',
}

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'commit-gate-home-'))
process.env.MERCURY_CONFIG_DIR = ISOLATED_HOME
process.env.MERCURY_HOME = ISOLATED_HOME
const { getMercuryHome } = await import('../../src/utils/envUtils.js')
const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.js')
const { getCwd } = await import('../../src/utils/cwd.js')
for (const driveCwd of new Set([getCwd(), process.cwd(), realpathSync(process.cwd())])) {
  const verifyDir = join(getMercuryHome(), 'verify', sanitizePath(driveCwd))
  mkdirSync(verifyDir, { recursive: true })
  writeFileSync(join(verifyDir, 'evidence.json'), JSON.stringify({ schema: 1, records: [] }))
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Standalone commit gate (Feature B) — behavior proof')
console.log('============================================================')

const fh = await import('../../src/guards/commitGate.js')
const { guardsEngaged, judgeToolCall } = await import('../../src/guards/guards.js')
const { readFileSync } = await import('node:fs')
const cg = await import('../../src/guards/commitGate.js')

const sid = 'proof-commit-gate'
const gateEngaged = (): boolean => guardsEngaged(sid).tool.includes(cg.COMMIT_GATE_ID)
const judge = async (tool: string, command: string): Promise<boolean> => {
  const verdict = await judgeToolCall(sid, { tool, input: { command }, callId: 'commit-gate-call', messages: [] })
  return !verdict.refused
}

section('explicit MERCURY_COMMIT_GATE=0 short-circuits first (advertised opt-out is true)')
{
  const src = readFileSync('src/guards/commitGate.ts', 'utf8')
  const hardOff = src.indexOf("if (flagEnv('MERCURY_COMMIT_GATE') === '0') return { allow: true }")
  const gate = src.indexOf('if (!commitGateEnabled()) return { allow: true }')
  check('explicit =0 short-circuit present', hardOff !== -1)
  check('…and it sits BEFORE the live gate check', gate !== -1 && hardOff < gate)
}

section('default-OFF gate truth table (DEFAULT-OFF, opt in MERCURY_COMMIT_GATE=1)')
{
  delete process.env.MERCURY_COMMIT_GATE
  check('OFF (no flag): commitGateEnabled() === false', fh.commitGateEnabled() === false)
  check('OFF: engageCommitGate is a no-op (returns false, no throw)', fh.engageCommitGate(sid) === false)
  check('OFF: nothing registered (byte-identical — no gate)', gateEngaged() === false)

  process.env.MERCURY_COMMIT_GATE = '1'
  check('ON (MERCURY_COMMIT_GATE=1): commitGateEnabled() === true', fh.commitGateEnabled() === true)
}

section('engage installs the PreToolUse(Bash) gate (no ReferenceError — the original crash is fixed)')
{
  const installed = fh.engageCommitGate(sid)
  check('engageCommitGate returned true (installed)', installed === true)
  check('isCommitGateEngaged(sid) === true (session-keyed guards)', fh.isCommitGateEngaged(sid) === true)
  check('the gate is engaged before the session\'s tool calls under COMMIT_GATE_ID', gateEngaged())
  check('re-engage is idempotent (no second install)', fh.engageCommitGate(sid) === false && guardsEngaged(sid).tool.filter(id => id === cg.COMMIT_GATE_ID).length === 1)
}

section('the installed gate DENIES a non-green commit and ALLOWS a green-gated one')
{
  if (!gateEngaged()) {
    check('gate present to drive', false)
  } else {
    const allowed = async (cmd: string) => judge('Bash', cmd)
    check('bare `git commit -m "wip"` is DENIED (the gate refuses)', (await allowed('git commit -m "wip"')) === false)
    check('`git commit --no-verify` is DENIED', (await allowed('git commit --no-verify -m "skip"')) === false)
    check('a green-gated `bun run build.ts && git commit` is ALLOWED', (await allowed('bun run build.ts && git commit -m "done"')) === true)
    check('the canonical `bash scripts/run-all-suites.sh && git commit` is ALLOWED', (await allowed('bash scripts/run-all-suites.sh && git commit -m "x"')) === true)
    check('a non-commit Bash command passes straight through', (await allowed('ls -la')) === true)
    const allowedPS = async (cmd: string) => judge('PowerShell', cmd)
    check('PowerShell-tool bare `git commit` is DENIED (HB-0130)', (await allowedPS('git commit -m "wip"')) === false)
    check('PowerShell-tool green-gated commit is ALLOWED', (await allowedPS('bun run build.ts && git commit -m "ok"')) === true)
  }
}

section('disengage removes the gate (no leak)')
{
  check('disengageCommitGate returned true', fh.disengageCommitGate(sid) === true)
  check('isCommitGateEngaged(sid) === false after disengage', fh.isCommitGateEngaged(sid) === false)
  check('the gate is gone', gateEngaged() === false)
}

section("pure evaluateCommitGate — the gate's deny rules (loadable, exported)")
{
  check('bare commit → bare-commit deny', cg.evaluateCommitGate('git commit -m "x"').allow === false && cg.evaluateCommitGate('git commit -m "x"').rule === 'bare-commit')
  check('--no-verify → no-verify-flag deny', cg.evaluateCommitGate('npm test && git commit --no-verify -m "x"').allow === false)
  check('chained verify → chained-verify allow', cg.evaluateCommitGate('npm test && git commit -m "x"').rule === 'chained-verify')
  check('no commit at all → not-a-commit allow', cg.evaluateCommitGate('echo hi').allow === true)
  check('a commit MESSAGE containing "test" does NOT satisfy the gate', cg.evaluateCommitGate('git commit -m "add a test"').allow === false)
  check('no-op head `echo pytest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('echo pytest && git commit -m "x"').allow === false)
  check('no-op head `true vitest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('true vitest && git commit -m "x"').allow === false)
  check('no-op head `: green-gate && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate(': green-gate && git commit -m "x"').allow === false)
  check('no-op head `test -f x && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('test -f x && git commit -m "x"').allow === false)
  check('real verify `pytest && git commit` is ALLOWED', cg.evaluateCommitGate('pytest && git commit -m "x"').allow === true)
  check('env-prefixed real verify `FOO=1 pytest && git commit` is ALLOWED', cg.evaluateCommitGate('FOO=1 pytest && git commit -m "x"').allow === true)

  check('`npm --prefix tools/x test -- --run && git commit` is ALLOWED (the AVS literal)',
    cg.evaluateCommitGate('node --check a.js && npm --prefix tools/azgaar-avs test -- --run && git commit -m "x"').allow === true)
  check('`pnpm -C pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('pnpm -C pkg test && git commit -m "x"').allow === true)
  check('`yarn --cwd pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('yarn --cwd pkg test && git commit -m "x"').allow === true)
  check('`npm -w app run build && git commit` is ALLOWED', cg.evaluateCommitGate('npm -w app run build && git commit -m "x"').allow === true)
  check('piped verify `npm test | tail -5 && git commit` stays DENIED', cg.evaluateCommitGate('npm test | tail -5 && git commit -m "x"').allow === false)
  check('subshell verify `(cd pkg && npm test) && git commit` is ALLOWED', cg.evaluateCommitGate('(cd pkg && npm test) && git commit -m "x"').allow === true)
  check('`npm --prefix` with no verb stays DENIED', cg.evaluateCommitGate('npm --prefix tools/x && git commit -m "x"').allow === false)
}

section('source: engageCommitGate is WIRED into the turn (not severed)')
{
  const qe = readFileSync(join(import.meta.dir, '..', '..', 'src', 'rows', 'turn.ts'), 'utf-8')
  check('the turn imports engageCommitGate', /import \{[^}]*engageCommitGate[^}]*\} from '..\/guards\/commitGate.js'/.test(qe))
  check('engageCommitGate is CALLED in the engage block (unconditional)', qe.includes('engageCommitGate(sessionId)'))
}

section('dist: the wired standalone gate ships in dist/mercury.mjs')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the opt-in flag ships', present('MERCURY_COMMIT_GATE'))
    check('the commit-gate engage log ships', present('[commit-gate] engaged for session'))
    check('the commit-gate reprompt ships', present('Commit gate: this commit is not verified'))
  }
}

rmSync(ISOLATED_HOME, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL COMMIT-GATE PROOFS PASS')
else console.log(`❌ ${failures} COMMIT-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
