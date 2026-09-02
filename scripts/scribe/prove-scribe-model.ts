#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-scribe-model.ts
//  PROOF: Scribe Mode "Amanuensis" is a COUPLED model+effort-pinned mode.
//  Entering the scribe carousel station pins the foreground session to
//  the scribe seat pin (so the footer model label reads the pinned seat, not
//  whatever the session launched as), and on leave restores the operator's
//  prior model+effort — UNLESS they manually switched models in the meantime.
//
//  scribeModelPin.ts + effort.ts are loadable under `bun run`, so the pure
//  pin/restore decision + the effort resolution are exercised for real. The
//  PromptInput.tsx wiring (not loadable here) is asserted structurally.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-scribe-model.ts
// ============================================================================

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
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Scribe model+effort pin — proof')
console.log('============================================================')

setStamp(true)

// Hermetic config home: the pin resolves LIVE through the persisted
// seat-slot tier — the operator's REAL ~/.mercury/seat-slots.json (they can
// legitimately slot scribe=fable!) must never steer these default assertions.
// ALL FOUR home spellings: MERCURY_CONFIG_DIR /
// MERCURY_HOME OUTRANK the pinned MERCURY_CONFIG_DIR — an ambient value plus
// an operator-slotted scribe seat would flip the default-seat legs in-pool.
const ENVK = ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_HOME', 'MERCURY_SCRIBE_MODEL', 'MERCURY_SCRIBE_MODEL'] as const
const envStash: Record<string, string | undefined> = {}
for (const k of ENVK) { envStash[k] = process.env[k]; delete process.env[k] }
process.env.MERCURY_CONFIG_DIR = `/tmp/hermes-prove-scribe-model-${process.pid}`

const pin = (await import('../../src/utils/scribe/scribeModelPin.js')) as typeof import('../../src/utils/scribe/scribeModelPin.js')
const effort = (await import('../../src/utils/effort.js')) as typeof import('../../src/utils/effort.js')

section('constants')
check("scribeSeatModel() === 'claude-fable-5[1m]' (D-02a frontier front)", pin.scribeSeatModel() === 'claude-fable-5[1m]', pin.scribeSeatModel())
check("scribeSeatEffort() === 'xhigh' (the Scribe routes at xhigh; the Implementer earns max)", pin.scribeSeatEffort() === 'xhigh', String(pin.scribeSeatEffort()))

section('effort resolution: the scribe seat supports the xhigh floor; xhigh is NOT clamped')
check('modelSupportsXHighEffort(SCRIBE_MODEL) is true', effort.modelSupportsXHighEffort(pin.scribeSeatModel()) === true)
check(
  "resolveAppliedEffort(SCRIBE_MODEL, SCRIBE_EFFORT) === SCRIBE_EFFORT (not clamped to high)",
  effort.resolveAppliedEffort(pin.scribeSeatModel(), pin.scribeSeatEffort()) === pin.scribeSeatEffort(),
  String(effort.resolveAppliedEffort(pin.scribeSeatModel(), pin.scribeSeatEffort())),
)
check('scribePinIsApplicable() is true', pin.scribePinIsApplicable() === true)

section('decideScribeEngage: returns the pinned model+effort pair')
const engage = pin.decideScribeEngage()
check('engage is non-null', engage !== null)
check('engage.model === SCRIBE_MODEL', engage?.model === pin.scribeSeatModel())
check('engage.effort === SCRIBE_EFFORT', engage?.effort === pin.scribeSeatEffort())

section('modelIsScribePin')
check('pinned model matches (fable-5[1m])', pin.modelIsScribePin('claude-fable-5[1m]') === true)
check('opus-4-6 does NOT match (no longer the pin)', pin.modelIsScribePin('claude-opus-4-6[1m]') === false)
check('null does NOT match', pin.modelIsScribePin(null) === false)
check('undefined does NOT match', pin.modelIsScribePin(undefined) === false)

section('1M-context preference (the /model router `c` toggle)')
check('default (no pref) ⇒ resolvedScribeModel === SCRIBE_MODEL', pin.resolvedScribeModel() === pin.scribeSeatModel())
pin.setScribeContext1mPref(true)
check('pref true ⇒ resolvedScribeModel carries [1m]', /\[1m\]$/.test(pin.resolvedScribeModel()))
check('pref true ⇒ modelIsScribePin matches the [1m] variant', pin.modelIsScribePin(pin.resolvedScribeModel()))
pin.setScribeContext1mPref(false)
check('pref false ⇒ strips [1m] (200k variant)', !/\[1m\]/.test(pin.resolvedScribeModel()) && pin.resolvedScribeModel() === pin.scribeSeatModel().replace(/\[1m\]$/, ''))
check('pref false ⇒ modelIsScribePin tracks the 200k variant (NOT the [1m] one)', pin.modelIsScribePin(pin.resolvedScribeModel()) && !pin.modelIsScribePin(pin.scribeSeatModel()))
pin.setScribeContext1mPref(undefined) // reset — keep the module global clean for the sections below
check('cleared ⇒ resolvedScribeModel back to SCRIBE_MODEL', pin.resolvedScribeModel() === pin.scribeSeatModel())

section('FAMILY-AWARE 1M pref (the minted gpt-5.6-sol[1m] class)')
// The [1m] suffix is a Claude VARIANT mechanism — a base with no 1M variant
// (gpt/glm-slotted seats) must NEVER have it minted onto its id: the minted
// id exists nowhere, scribePinIsApplicable() failed on it, and the engage
// pin silently skipped. The picker's own gate is the one owner.
{
  const mo = (await import('../../src/utils/model/modelOptions.js')) as typeof import('../../src/utils/model/modelOptions.js')
  check('the picker gate refuses the toggle for a gpt id (no 1M variant exists)', mo.focusedOptionSupports1m('gpt-5.6-sol') === false)
  const pinSrc = src('utils', 'scribe', 'scribeModelPin.ts')
  check('resolvedScribeModel guards the suffix on the picker gate (no minting)', /if \(!focusedOptionSupports1m\(base\)\) return base/.test(pinSrc))
  const moSrc = src('utils', 'model', 'modelOptions.ts')
  check(
    "the router row's 1M affordance derives from the RESOLVED scribe seat",
    /SCRIBE_ROUTER_OPTION_VALUE\) \{\s*\n\s*return focusedOptionSupports1m\(stripContext1m\(resolveScribeSeat\(\)\.model\)\)/.test(moSrc),
  )
  const mm = src('commands', 'model', 'mercuryModel.tsx')
  check(
    "the router row's ctx column shows what ↵ delivers (resolvedScribeModel)",
    /v === SCRIBE_ROUTER_OPTION_VALUE\s*\n?\s*\? resolvedScribeModel\(\)/.test(mm),
  )
}

section('daemon reap-on-exit decision (the lingering-daemon wart fix)')
const esd = (await import('../../src/utils/scribe/ensureScribeDaemon.js')) as typeof import('../../src/utils/scribe/ensureScribeDaemon.js')
check('default (no env) ⇒ reap the auto-started daemon', esd.shouldReapAutoStartedDaemon(undefined) === true)
check('MERCURY_SCRIBE_DAEMON_PERSIST=1 ⇒ keep it warm (opt-out)', esd.shouldReapAutoStartedDaemon('1') === false)
check('any other value ⇒ still reap', esd.shouldReapAutoStartedDaemon('0') === true)

section('decideScribeRestore: restore stash only when still on the pinned model+effort')
const stash = { model: 'claude-opus-4-6[1m]', effort: 'xhigh' as const } // a non-pin "earlier Opus" the operator was on
// Normal leave: still SCRIBE_MODEL @ SCRIBE_EFFORT ⇒ restore the stash verbatim.
const r1 = pin.decideScribeRestore(stash, pin.scribeSeatModel(), pin.scribeSeatEffort())
check('still-pinned ⇒ restores stash', r1 !== null && r1.model === stash.model && r1.effort === stash.effort)
// Stash captured a null session-model (operator had no override) ⇒ restore null.
const r2 = pin.decideScribeRestore({ model: null, effort: undefined }, pin.scribeSeatModel(), pin.scribeSeatEffort())
check('still-pinned, null stash ⇒ restores {null,undefined}', r2 !== null && r2.model === null && r2.effort === undefined)
// EDGE CASE: operator manually switched off SCRIBE_MODEL (to some other model) mid-mode.
const r3 = pin.decideScribeRestore(stash, 'claude-sonnet-4-6', pin.scribeSeatEffort())
check('operator changed model ⇒ null (do NOT clobber newer choice)', r3 === null)
const r4 = pin.decideScribeRestore(stash, null, pin.scribeSeatEffort())
check('operator cleared to default ⇒ null (do NOT clobber)', r4 === null)
// No stash (engage never pinned) ⇒ nothing to restore.
const r5 = pin.decideScribeRestore(null, pin.scribeSeatModel(), pin.scribeSeatEffort())
check('no stash ⇒ null', r5 === null)
// EDGE CASE (audit-2 #7): operator changed /effort while still on the pin model ⇒
// keep the manual effort, restore only the model (don't clobber the newer choice).
const r6 = pin.decideScribeRestore(stash, pin.scribeSeatModel(), 'high')
check('manual /effort while pinned ⇒ restores model, keeps live effort', r6 !== null && r6.model === stash.model && r6.effort === 'high')

section('decideScribeSessionModel: idempotent unified pin for ALL engage paths')
// Fresh launch (no session override, default model) ⇒ pin + stash the empty snapshot.
const s1 = pin.decideScribeSessionModel({ model: null, effort: undefined })
check('fresh launch ⇒ non-null', s1 !== null)
check('fresh launch ⇒ next is the scribe pin', s1?.next.model === pin.scribeSeatModel() && s1?.next.effort === pin.scribeSeatEffort())
check('fresh launch ⇒ snapshot captures the pre-pin {null,undefined}', s1?.snapshot.model === null && s1?.snapshot.effort === undefined)
// Operator had a different model (opus-4-6@xhigh) ⇒ pin to the scribe seat (fable-5[1m]@xhigh), stash opus-4-6@xhigh.
const s2 = pin.decideScribeSessionModel({ model: 'claude-opus-4-6[1m]', effort: 'xhigh' })
check('other-model session ⇒ next is the scribe pin (fable-5[1m]@xhigh)', s2?.next.model === pin.scribeSeatModel() && s2?.next.effort === pin.scribeSeatEffort())
check('other-model session ⇒ snapshot captures opus-4-6@xhigh (restore target)', s2?.snapshot.model === 'claude-opus-4-6[1m]' && s2?.snapshot.effort === 'xhigh')
// IDEMPOTENT: already on the scribe pin ⇒ null (never re-stash / re-write, so a
// StrictMode double-invoke or a re-engage can't clobber the stashed restore target).
const s3 = pin.decideScribeSessionModel({ model: pin.scribeSeatModel(), effort: pin.scribeSeatEffort() })
check('already pinned ⇒ null (idempotent, no re-stash)', s3 === null)
// AUDIT FIX (scribe-audit #1): model already the pin but effort NOT the seat
// effort (e.g. an operator already on the pin model at high, or a 3P provider
// storing the literal id) ⇒ must STILL pin the seat effort (the documented
// "seat effort on every engage path" — xhigh since D-02a), stashing the prior
// effort. Only model==pin AND effort==seat-effort is the true idempotent no-op.
const s4 = pin.decideScribeSessionModel({ model: pin.scribeSeatModel(), effort: 'high' })
check('model==pin but effort=high ⇒ decision that pins the seat effort (not null)', s4 !== null && s4.next.effort === pin.scribeSeatEffort() && s4.next.model === pin.scribeSeatModel())
check('model==pin & effort=high ⇒ snapshot stashes the prior effort (high)', s4?.snapshot.effort === 'high')

section('engageScribeSession: ONE imperative write path for every engage route')
// A fake AppState store (getState/setState) — exercises the real imperative
// helper with no React. Mirrors src/state/store.ts Store<T>.
type FakeState = { mainLoopModel: string | null; mainLoopModelForSession: string | null; effortValue: string | undefined }
function makeStore(init: Partial<FakeState>) {
  let state: FakeState = { mainLoopModel: null, mainLoopModelForSession: null, effortValue: undefined, ...init }
  return {
    getState: () => state,
    setState: (u: (p: FakeState) => FakeState) => { state = u(state) },
    subscribe: () => () => {},
    peek: () => state,
  }
}
const sess = (await import('../../src/utils/scribe/engageScribeSession.js')) as typeof import('../../src/utils/scribe/engageScribeSession.js')

// Scenario A — fresh launch (default model, no override): engage pins the scribe
// seat (fable-5[1m]@xhigh), re-engage is idempotent, disengage restores to the
// launch default.
const A = makeStore({})
sess.engageScribeSession(A as never)
check('A engage ⇒ mainLoopModelForSession = scribe pin', A.peek().mainLoopModelForSession === pin.scribeSeatModel())
check('A engage ⇒ effortValue = xhigh (the Scribe floor)', A.peek().effortValue === pin.scribeSeatEffort())
sess.engageScribeSession(A as never)
check('A re-engage ⇒ idempotent no-op (still fable-5[1m]@xhigh)', A.peek().mainLoopModelForSession === pin.scribeSeatModel() && A.peek().effortValue === pin.scribeSeatEffort())
sess.disengageScribeSession(A as never)
check('A disengage ⇒ restores launch default {null, undefined}', A.peek().mainLoopModelForSession === null && A.peek().effortValue === undefined)

// Scenario B — operator on opus-4-6@xhigh (a different model): engage pins fable-5[1m]@xhigh + stashes; disengage restores opus-4-6@xhigh.
const B = makeStore({ mainLoopModel: 'claude-opus-4-6[1m]', effortValue: 'xhigh' })
sess.engageScribeSession(B as never)
check('B engage ⇒ pins the scribe pin (fable-5[1m]@xhigh) over the opus-4-6 base', B.peek().mainLoopModelForSession === pin.scribeSeatModel() && B.peek().effortValue === pin.scribeSeatEffort())
sess.disengageScribeSession(B as never)
check('B disengage ⇒ restores opus-4-6@xhigh', B.peek().mainLoopModelForSession === 'claude-opus-4-6[1m]' && B.peek().effortValue === 'xhigh')

// Scenario C — never clobber a manual /model switch made WHILE in scribe mode.
const C = makeStore({})
sess.engageScribeSession(C as never)
C.setState(p => ({ ...p, mainLoopModelForSession: 'claude-opus-4-6[1m]', effortValue: 'xhigh' })) // operator switches to a different (non-pin) model mid-mode
sess.disengageScribeSession(C as never)
check('C disengage ⇒ does NOT clobber the manual switch (opus-4-6)', C.peek().mainLoopModelForSession === 'claude-opus-4-6[1m]' && C.peek().effortValue === 'xhigh')

// Scenario D the pin applies stamp-independently.
setStamp(false)
const D = makeStore({})
sess.engageScribeSession(D as never)
check('D (bare stamp) engage ⇒ SAME pin as Scenario A (stamp-independence)', D.peek().mainLoopModelForSession === pin.scribeSeatModel() && D.peek().effortValue === pin.scribeSeatEffort())
sess.disengageScribeSession(D as never)
setStamp(true)

section('structural: shared engageScribeSession helper (the single write path)')
const es = src('utils', 'scribe', 'engageScribeSession.ts')
check('helper stash-restore floor intact (if (!restore) return)', /if \(!restore\) return/.test(es))
check('helper holds a MODULE-level stash (not a component ref)', /^let sessionStash/m.test(es))
check('engage calls the pure decideScribeSessionModel', /decideScribeSessionModel\(current\)/.test(es))
check('engage idempotency guard (already-engaged stash held ⇒ no re-stash)', /if\s*\(sessionStash\s*!==\s*null\)\s*return/.test(es))
check('engage writes mainLoopModelForSession + effortValue', /mainLoopModelForSession:\s*decision\.next\.model[\s\S]{0,80}effortValue:\s*decision\.next\.effort/.test(es))
check('disengage routes through decideScribeRestore (never-clobber, model+effort)', /decideScribeRestore\(sessionStash,\s*currentModel,\s*currentEffort\)/.test(es))

section('structural: PromptInput.tsx handleCycleMode wiring (uses the shared helper)')
const pi = src('components', 'PromptInput', 'PromptInput.tsx')
check('PromptInput owns no direct engage/disengage import (helper-only seam)', /import \{ classifyScribeRouterModel, handleScribeRouterSelect \}/.test(pi) && !/from '\.\.\/\.\.\/utils\/scribe\/engageScribeSession\.js'/.test(pi))
check('no longer carries a scribePinSnapshotRef (single source of truth)', !/scribePinSnapshotRef/.test(pi))
const routerSel = src('utils', 'scribe', 'scribeRouterSelect.ts')
check('PromptInput delegates router engage/disengage to the shared helper', /handleScribeRouterSelect\(value,/.test(pi))
check('the helper engages via engageScribeSession(deps.store)', /engageScribeSession\(deps\.store\)/.test(routerSel))
check('the helper disengages via disengageScribeSession(deps.store)', /disengageScribeSession\(deps\.store\)/.test(routerSel))
check("the helper's default outcome is 'not-router' (a real model select)", /return 'not-router'/.test(routerSel))

section('structural: REPL.tsx LAUNCH-path pin (MERCURY_SCRIBE=1 mount effect)')
const repl = src('screens', 'REPL.tsx')
check('REPL imports isScribeModeOn + engageScribeSession', /isScribeModeOn[\s\S]{0,160}engageScribeSession/.test(repl))
check(
  'mount effect pins via the shared helper on fork + scribe mode',
  /if \(isScribeModeOn\(\)\) \{\s*\n\s*try \{\s*\n\s*engageScribeSession\(store\);/.test(repl),
)

section('structural: QueryEngine.ts HEADLESS pin (-p / print parity)')
const qe = src('QueryEngine.ts')
check('imports scribeSeatModel + scribeSeatEffort + scribePinIsApplicable', /scribePinIsApplicable,/.test(qe) && /scribeSeatEffort,/.test(qe) && /scribeSeatModel,/.test(qe))
check(
  'headless model resolves to the live scribe seat when scribe mode on (over --model)',
  /isScribeModeOn\(\) && scribePinIsApplicable\(\)\s*\n?\s*\? scribeSeatModel\(\)\s*\n?\s*: \(this\.#userSpecifiedModel \?\? getMainLoopModel\(\)\)/.test(qe),
)
check(
  'headless effort pinned to the live scribe-seat effort in the scribe-engage block',
  /isScribeModeOn\(\)\) \{[\s\S]{0,400}scribePinIsApplicable\(\)[\s\S]{0,120}scribeSeatEffort\(\)[\s\S]{0,120}effort: seatEffort/.test(qe),
)

section('structural: the composer reads the session override (drives the label)')
// The third rung is the focused chat's main model, read through its
// connector (a seated composer labels the seat's model, not the process's).
check(
  "label reads mainLoopModelForSession ?? mainLoopModel ?? the focused chat's model (the composer overlay)",
  /mainLoopModelForSession \?\? mainLoopModel \?\? focusedMainModel/.test(pi),
)

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-MODEL PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-MODEL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
