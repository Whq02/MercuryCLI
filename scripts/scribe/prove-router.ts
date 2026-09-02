#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-router.ts
//  PROOF (#42 R3): the open-router-like per-task router matches the Implementer's
//  effort to each task's hardness (MAX only where it pays) — the benchmark-quality
//  lever. Pure deterministic classifier + envelope-override resolution + the gate
//  (default-OFF until A/B-benchmarked) + the daemon wiring that applies effort via a
//  RESPAWN ONLY at an idle turn boundary (coherence: never mid-task). OFF ⇒ the fixed
//  pin, byte-identical.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-router.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const r = (await import('../../src/utils/scribe/dispatchRouter.js')) as typeof import('../../src/utils/scribe/dispatchRouter.js')
const g = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')

console.log('============================================================')
console.log(' Open-router per-task router (#42 R3) — proof')
console.log('============================================================')

section('decideDispatchRoute (pure) — effort matched to hardness')
check('deep keyword (refactor) ⇒ max', r.decideDispatchRoute('Refactor the auth module').effort === 'max')
check('deep keyword (migrate/security) ⇒ max', r.decideDispatchRoute('migrate the schema; security audit').effort === 'max')
check('≥3 files ⇒ max (blast radius)', r.decideDispatchRoute('touch a.ts, b.tsx and c.js').effort === 'max')
check('long spec (≥600 chars) ⇒ max', r.decideDispatchRoute('x '.repeat(320)).effort === 'max')
check('mechanical (rename, ≤1 file, short) ⇒ high', r.decideDispatchRoute('rename the foo variable', { title: 'typo' }).effort === 'high')
check('mechanical (fix a comment) ⇒ high', r.decideDispatchRoute('fix the comment in util.ts').effort === 'high')
check('standard task ⇒ xhigh (the non-trivial FLOOR — never under-power real work)', r.decideDispatchRoute('add a --json flag to the status command').effort === 'xhigh')
check('a non-mechanical short task still ⇒ xhigh (not high)', r.decideDispatchRoute('wire the new endpoint').effort === 'xhigh')
check('lanes track effort', r.decideDispatchRoute('refactor x').lane === 'deep' && r.decideDispatchRoute('rename x', { title: 'typo' }).lane === 'quick')

section('resolveDispatchEffort — Scribe envelope override wins, else the classifier')
check('explicit envelope effort wins (Scribe judgment)', r.resolveDispatchEffort('rename x', 'max').effort === 'max' && r.resolveDispatchEffort('rename x', 'max').source === 'envelope')
check('no envelope ⇒ classifier decides', r.resolveDispatchEffort('refactor the module', undefined).source === 'classifier' && r.resolveDispatchEffort('refactor the module', undefined).effort === 'max')
check('bogus envelope effort ⇒ falls back to the classifier (never an invalid effort)', r.resolveDispatchEffort('rename the var', 'turbo').source === 'classifier')
check('normalizeRouteEffort clamps to the allowed set', r.normalizeRouteEffort('xhigh') === 'xhigh' && r.normalizeRouteEffort('nope') === undefined)

section('gate (MERCURY_SCRIBE_TASK_ROUTER) — OPT-IN, default-OFF until benchmarked')
delete process.env.MERCURY_SCRIBE_TASK_ROUTER
check('default ⇒ OFF (fixed pin, byte-identical)', g.scribeTaskRouterEnabled() === false)
process.env.MERCURY_SCRIBE_TASK_ROUTER = '1'
check('=1 ⇒ armed (explicit opt-in after A/B benchmark)', g.scribeTaskRouterEnabled() === true)
delete process.env.MERCURY_SCRIBE_TASK_ROUTER

section('wiring (structural) — applied via respawn ONLY at an idle boundary (coherence)')
const bridge = src('daemon', 'scribeDispatchBridge.ts')
check('the bridge takes the router resolveRoute/currentRoute/reconfigureRoute seam', /resolveRoute\?:/.test(bridge) && /currentRoute\?:/.test(bridge) && /reconfigureRoute\?:/.test(bridge) && /onRouteHeld\?:/.test(bridge))
check('it reconfigures BEFORE delivery + HOLDS (only inside the !busy idle branch)', /const want = opts\.resolveRoute\?\.\(chosen\.env\)/.test(bridge) && /opts\.reconfigureRoute\(patch\)/.test(bridge))
const main = src('daemon', 'main.ts')
check('the daemon wires the route seam when routerEnabled, the legacy effort wrapper only under =0 + TF arm', /const routerOn = routerEnabled\(\)/.test(main) && /const taskRouter = scribeTaskRouterEnabled\(\)/.test(main) && /resolveScribeDispatchRoute\(env, implementerRoute\(\)\)/.test(main) && /resolveDispatchEffort\(env\.task, env\.route\?\.effort/.test(main))
check('route applied via reconfigureLongLived (a respawn — the existing seam)', /patch => \{ r\.reconfigureLongLived\('implementer', patch\) \}/.test(main))
const bus = src('utils', 'scribe', 'scribeBus.ts')
check('DispatchEnvelope carries the optional route (+model) and routePlan identity, inert when absent', /route\?: \{ effort\?: string; lane\?: string; model\?: string \}/.test(bus) && /routePlan\?: \{ planId: string; nodeId: string; revision: number; attempt: number \}/.test(bus))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ROUTER PROOFS PASS')
else console.log(`❌ ${failures} ROUTER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
