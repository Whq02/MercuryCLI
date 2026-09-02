#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-commit-gate.ts
//  PROOF (Feature B): the STANDALONE commit gate — engaging installs the
//  PreToolUse(Bash) gate and a non-green (bare / --no-verify) commit is DENIED;
//  default-OFF so a default session is byte-identical.
//
//  The original was BROKEN two ways: (1) engageCommitGate referenced a renamed
//  variable (`if (engaged)` after the rename to `engagedFor`) → guaranteed
//  ReferenceError if ever called; (2) it was SEVERED — never wired into any
//  engage path. This proof drives the REAL engage path end-to-end (no
//  ReferenceError), pulls the registered callback out of the session store, and
//  executes it against a bare commit (deny) and a chained-verify commit (allow).
//
//  Fork is simulated via globalThis.MACRO (memory/wire-live-substrate-program)
//  so the build stamp is true and engageCommitGate actually runs.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-commit-gate.ts
// ============================================================================

// Simulate the stamped build BEFORE any import reads MACRO.VERSION.
;(globalThis as any).MACRO = {
  VERSION: '2.1.0-hermes',
  ISSUES_EXPLAINER: 'x',
  PACKAGE_URL: 'x',
  README_URL: 'x',
  VERSION_TAG: 'x',
}

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const fh = await import('../../src/utils/hooks/commitGate.js')
const sh = await import('../../src/utils/hooks/sessionHooks.js')
const { readFileSync } = await import('node:fs')
const cg = await import('../../src/utils/hooks/commitGate.js')

// A minimal AppState carrying a real sessionHooks Map — exactly the container
// the live setAppState mutates.
const sid = 'proof-commit-gate'
let appState: any = { sessionHooks: new Map() }
const setAppState = (fn: (p: any) => any) => {
  appState = fn(appState)
}
const gateCallback = () => {
  const fnHooks = sh.getSessionFunctionHooks(appState, sid, 'PreToolUse' as any)
  const matchers = (fnHooks.get('PreToolUse' as any) || []) as any[]
  const all = matchers.flatMap(m => m.hooks)
  return { matchers, gate: all.find((h: any) => h.id === cg.COMMIT_GATE_ID) }
}
const pre = (command: string) => ({
  hookInput: {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  },
})
// Same shape but via the Windows PowerShell tool (the gate would otherwise be
// Bash-only, so a PowerShell `git commit` bypassed it).
const prePS = (command: string) => ({
  hookInput: {
    hook_event_name: 'PreToolUse',
    tool_name: 'PowerShell',
    tool_input: { command },
  },
})

// env-supremacy (operator repro): the block message advertises
// "=0 to disable"; the hook short-circuits on an EXPLICIT '0' before the
// live gate read — pin it structurally (the hook body is a closure — not
// invocable in isolation).
section('explicit MERCURY_COMMIT_GATE=0 short-circuits first (advertised opt-out is true)')
{
  const src = readFileSync('src/utils/hooks/commitGate.ts', 'utf8')
  const hardOff = src.indexOf("if (flagEnv('MERCURY_COMMIT_GATE') === '0') return true")
  const gate = src.indexOf('if (!commitGateEnabled()) return true')
  check('explicit =0 short-circuit present', hardOff !== -1)
  check('…and it sits BEFORE the live gate check', gate !== -1 && hardOff < gate)
}

section('default-OFF gate truth table (DEFAULT-OFF, opt in MERCURY_COMMIT_GATE=1)')
{
  delete process.env.MERCURY_COMMIT_GATE
  check('OFF (no flag): commitGateEnabled() === false', fh.commitGateEnabled() === false)
  // engage is a no-op when disabled — no ReferenceError, returns false.
  check('OFF: engageCommitGate is a no-op (returns false, no throw)', fh.engageCommitGate(setAppState, sid) === false)
  check('OFF: nothing registered (byte-identical — no gate)', gateCallback().gate === undefined)

  process.env.MERCURY_COMMIT_GATE = '1'
  check('ON (MERCURY_COMMIT_GATE=1): commitGateEnabled() === true', fh.commitGateEnabled() === true)
}

section('engage installs the PreToolUse(Bash) gate (no ReferenceError — the original crash is fixed)')
{
  // The ORIGINAL bug: `if (engaged) return false` after the var was renamed →
  // a ReferenceError the moment this ran. If it threw, this proof would abort.
  const installed = fh.engageCommitGate(setAppState, sid)
  check('engageCommitGate returned true (installed)', installed === true)
  check('isCommitGateEngaged(sid) === true (session-keyed guards)', fh.isCommitGateEngaged(sid) === true)
  const { matchers, gate } = gateCallback()
  check('a PreToolUse hook is registered matching Bash AND PowerShell (HB-0130)', matchers.some(m => m.matcher === 'Bash|PowerShell'))
  check('the registered hook carries COMMIT_GATE_ID', !!gate && gate.id === cg.COMMIT_GATE_ID)
  check('re-engage is idempotent (no second install)', fh.engageCommitGate(setAppState, sid) === false)
}

section('the installed gate DENIES a non-green commit and ALLOWS a green-gated one')
{
  const { gate } = gateCallback()
  if (!gate) {
    check('gate present to drive', false)
  } else {
    // Drive the EXACT registered callback (the live PreToolUse path runs this).
    const allowed = async (cmd: string) => await gate.callback([], undefined, pre(cmd))
    check('bare `git commit -m "wip"` is DENIED (callback → false)', (await allowed('git commit -m "wip"')) === false)
    check('`git commit --no-verify` is DENIED', (await allowed('git commit --no-verify -m "skip"')) === false)
    check('a green-gated `bun run build.ts && git commit` is ALLOWED', (await allowed('bun run build.ts && git commit -m "done"')) === true)
    check('Hermes canonical `bash scripts/run-all-suites.sh && git commit` is ALLOWED', (await allowed('bash scripts/run-all-suites.sh && git commit -m "x"')) === true)
    check('a non-commit Bash command passes straight through', (await allowed('ls -la')) === true)
    // the same gate must catch a git commit issued via the PowerShell tool.
    const allowedPS = async (cmd: string) => await gate.callback([], undefined, prePS(cmd))
    check('PowerShell-tool bare `git commit` is DENIED (HB-0130)', (await allowedPS('git commit -m "wip"')) === false)
    check('PowerShell-tool green-gated commit is ALLOWED', (await allowedPS('bun run build.ts && git commit -m "ok"')) === true)
  }
}

section('disengage removes the gate (no leak)')
{
  check('disengageCommitGate returned true', fh.disengageCommitGate(setAppState, sid) === true)
  check('isCommitGateEngaged(sid) === false after disengage', fh.isCommitGateEngaged(sid) === false)
  check('the PreToolUse Bash gate is gone', gateCallback().gate === undefined)
}

section("pure evaluateCommitGate — the gate's deny rules (loadable, exported)")
{
  check('bare commit → bare-commit deny', cg.evaluateCommitGate('git commit -m "x"').allow === false && cg.evaluateCommitGate('git commit -m "x"').rule === 'bare-commit')
  check('--no-verify → no-verify-flag deny', cg.evaluateCommitGate('npm test && git commit --no-verify -m "x"').allow === false)
  check('chained verify → chained-verify allow', cg.evaluateCommitGate('npm test && git commit -m "x"').rule === 'chained-verify')
  check('no commit at all → not-a-commit allow', cg.evaluateCommitGate('echo hi').allow === true)
  // The message word "test" must NOT count as a verify (quoted args blanked).
  check('a commit MESSAGE containing "test" does NOT satisfy the gate', cg.evaluateCommitGate('git commit -m "add a test"').allow === false)
  // a no-op/print head with a verify WORD as its ARGUMENT exits 0 without
  // running the runner → must NOT satisfy the gate (the && short-circuits on it).
  check('no-op head `echo pytest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('echo pytest && git commit -m "x"').allow === false)
  check('no-op head `true vitest && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('true vitest && git commit -m "x"').allow === false)
  check('no-op head `: green-gate && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate(': green-gate && git commit -m "x"').allow === false)
  check('no-op head `test -f x && git commit` is DENIED (HB-0099)', cg.evaluateCommitGate('test -f x && git commit -m "x"').allow === false)
  // ...but a REAL runner invocation (incl. an env-var prefix) still satisfies it.
  check('real verify `pytest && git commit` is ALLOWED', cg.evaluateCommitGate('pytest && git commit -m "x"').allow === true)
  check('env-prefixed real verify `FOO=1 pytest && git commit` is ALLOWED', cg.evaluateCommitGate('FOO=1 pytest && git commit -m "x"').allow === true)

  // recognizer widening (the AVS friction session): npm/yarn/pnpm
  // take a directory/workspace selector BETWEEN the tool and the verb — a
  // real `npm --prefix <dir> test` chain was denied as bare-commit.
  check('`npm --prefix tools/x test -- --run && git commit` is ALLOWED (the AVS literal)',
    cg.evaluateCommitGate('node --check a.js && npm --prefix tools/azgaar-avs test -- --run && git commit -m "x"').allow === true)
  check('`pnpm -C pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('pnpm -C pkg test && git commit -m "x"').allow === true)
  check('`yarn --cwd pkg test && git commit` is ALLOWED', cg.evaluateCommitGate('yarn --cwd pkg test && git commit -m "x"').allow === true)
  check('`npm -w app run build && git commit` is ALLOWED', cg.evaluateCommitGate('npm -w app run build && git commit -m "x"').allow === true)
  // The pipe rule STANDS (shell honesty: `verify | tail` exits with tail's
  // status, so && guards nothing) — the deny message now explains it.
  check('piped verify `npm test | tail -5 && git commit` stays DENIED', cg.evaluateCommitGate('npm test | tail -5 && git commit -m "x"').allow === false)
  check('subshell verify `(cd pkg && npm test) && git commit` is ALLOWED', cg.evaluateCommitGate('(cd pkg && npm test) && git commit -m "x"').allow === true)
  // The selector must not open a hole: a MESSAGE-ish or bogus form stays denied.
  check('`npm --prefix` with no verb stays DENIED', cg.evaluateCommitGate('npm --prefix tools/x && git commit -m "x"').allow === false)
}

section('source: engageCommitGate is WIRED into QueryEngine (not severed)')
{
  const qe = readFileSync(join(import.meta.dir, '..', '..', 'src', 'QueryEngine.ts'), 'utf-8')
  check('QueryEngine imports engageCommitGate', /import \{[^}]*engageCommitGate[^}]*\} from '.\/utils\/hooks\/commitGate.js'/.test(qe))
  check('engageCommitGate is CALLED in the engage block (unconditional)', qe.includes('engageCommitGate(setAppState, getSessionId())'))
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

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL COMMIT-GATE PROOFS PASS')
else console.log(`❌ ${failures} COMMIT-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
