#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-carousel.ts
//  PROOF (W2): Scribe Mode "Amanuensis" entry MOVED from the shift+tab carousel
//  into /model as a first-class "two-stream router" selection. So:
//    - getNextPermissionMode NO LONGER yields 'scribe' (no station, no case),
//    - the /model option list carries the SCRIBE_ROUTER_OPTION_VALUE sentinel
//      (fork + scribe-gated), ModelPicker hands it straight through, and
//      PromptInput.handleModelSelect engages on the sentinel / disengages on a
//      real model.
//  The 'scribe' PermissionMode type + config remain (substrate; just no longer a
//  carousel station). The footer-chip render is the vshot render-verify (separate).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-carousel.ts
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
console.log(' Scribe entry via /model (no carousel station) — W2 proof')
console.log('============================================================')

setStamp(true)
let loadable = true
let getNextPermissionMode: (ctx: unknown) => string
try {
  ;({ getNextPermissionMode } = (await import('../../src/utils/permissions/getNextPermissionMode.js')) as {
    getNextPermissionMode: (ctx: unknown) => string
  })
} catch (e) {
  loadable = false
  console.log(`  [info] getNextPermissionMode not loadable under bun-run (${String(e).split('\n')[0]}) — using structural assertions`)
}

const ctx = (mode: string) => ({ mode, isBypassPermissionsModeAvailable: false, isAutoModeAvailable: false })

if (loadable) {
  section('fork cycle no longer lands on scribe (strategy → apollo → flow|sovereign|default)')
  delete process.env.MERCURY_SCRIBE_MODE
  check('strategy → NOT scribe (station removed)', getNextPermissionMode!(ctx('strategy')) !== 'scribe')
  // Apollo station landed (the pre-flight interview): strategy
  // hands to apollo, which carries strategy's old exits.
  check('strategy → apollo (the interview station sits after strategy)', getNextPermissionMode!(ctx('strategy')) === 'apollo')
  check('apollo → flow|sovereign|default (never scribe)', ['flow', 'sovereign', 'default'].includes(getNextPermissionMode!(ctx('apollo'))))
  check('a stray scribe mode falls through to default', getNextPermissionMode!(ctx('scribe')) === 'default')
  // Flow is the operator's private tool — it MUST be a station in the fork
  // shift+tab carousel (default→implement→strategy→apollo→FLOW→sovereign),
  // available regardless of the remote provider/model rollout gates. With
  // sovereign also available, the cycle lands on flow FIRST (the lighter
  // classifier step before sovereign).
  check('FORK: apollo → flow (flow is a carousel station, before sovereign)', getNextPermissionMode!({ mode: 'apollo', isBypassPermissionsModeAvailable: true, isAutoModeAvailable: false }) === 'flow')
  check('FORK: flow → sovereign (cycle continues past flow)', getNextPermissionMode!({ mode: 'flow', isBypassPermissionsModeAvailable: true, isAutoModeAvailable: false }) === 'sovereign')
} else {
  section('structural: getNextPermissionMode no longer routes to scribe (src)')
  const gn = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('canEnterScribe removed', !/function canEnterScribe/.test(gn))
  check("plan branch no longer returns 'scribe'", !/return 'scribe'/.test(gn))
  check("case 'scribe' removed", !/case 'scribe':/.test(gn))
  check('scribeModeEnabled no longer imported here', !/scribeModeEnabled/.test(gn))
}

// Auto-mode availability — the operator's PRIVATE TOOL must be a carousel station
// regardless of the remote provider/model ROLLOUT gates (it only failed
// to appear because the operator runs a fork model / 3rd-party provider on purpose).
section('auto mode is fork-available in the carousel (provider/model gates bypassed)')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  // availability honors ONLY the genuine kill-switches (circuit
  // breaker, cached GB incident 'disabled', settings opt-out), then true.
  const gateFn = ps.slice(ps.indexOf('export function isAutoModeGateEnabled'), ps.indexOf('export function isAutoModeGateEnabled') + 2200)
  check('isAutoModeGateEnabled: circuit-breaker kill first', gateFn.indexOf('isAutoModeCircuitBroken') !== -1)
  check('isAutoModeGateEnabled: cached GB incident kill present', /getAutoModeEnabledStateIfCached\(\) === 'disabled'/.test(gateFn))
  check('isAutoModeGateEnabled: ends unconditional true (no provider rollout gate)', /return true\n\}/.test(gateFn) && !gateFn.includes('isAutoModeProviderEligible'))
  const reasonFn = ps.slice(ps.indexOf('export function getAutoModeUnavailableReason'), ps.indexOf('export function getAutoModeUnavailableReason') + 2200)
  check('getAutoModeUnavailableReason: mirrors the kill-switch-only shape', reasonFn.includes('circuit-breaker') && !reasonFn.includes("return 'provider'"))
  // canCycleToAuto gates the carousel solely on the live isAutoModeGateEnabled().
  const gn2 = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('canCycleToAuto returns the live gate (return gateEnabled)', /const gateEnabled = isAutoModeGateEnabled\(\)[\s\S]{0,300}return gateEnabled/.test(gn2))
}

section('scribe entry now lives in /model — the router sentinel (src)')
const opts = src('utils', 'model', 'modelOptions.ts')
check('getModelOptions appends the router entry, gated scribeModeEnabled()', /scribeModeEnabled\(\)[\s\S]{0,800}SCRIBE_ROUTER_OPTION_VALUE/.test(opts))
// De-pinned: the label is the MODE — models
// derive LIVE from the seat-slot resolver, never a hardcoded family string.
check('label names the mode, cost stays honest', /Scribe — two-stream router/.test(opts) && /~2× usage/.test(opts))
check('router-row models derive from the seat resolver (no pinned opus label)', /resolveScribeSeat\(\)/.test(opts) && /resolveImplementerSeat\(\)/.test(opts) && !/Scribe — 2× opus-4-8 router/.test(opts))
check('"(active)" suffix when already engaged', /isScribeModeOn\(\)[\s\S]{0,40}active/.test(opts) || /active \? ' \(active\)'/.test(opts))
check('allowlist filter preserves the sentinel (not a model id)', /opt\.value === SCRIBE_ROUTER_OPTION_VALUE/.test(opts))

const picker = src('components', 'ModelPicker.tsx')
check('ModelPicker.handleSelect: router rides the 1M toggle, workflows sentinel is plain (the rider is computed into withRider first)', /SCRIBE_ROUTER_OPTION_VALUE\)\s*\{[\s\S]{0,260}withContext1m\(value_0\)[\s\S]{0,160}onSelect\(withRider, undefined\)/.test(picker) && /SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE\s*\)\s*\{[\s\S]{0,80}onSelect\(value_0, undefined\)/.test(picker))

const pi = src('components', 'PromptInput', 'PromptInput.tsx')
const routerSrc = src('utils', 'scribe', 'scribeRouterSelect.ts')
check('BOTH /model pickers delegate to the shared router-select helper (value + setAppState + store)', /handleScribeRouterSelect\(value, \{ setAppState, store: appStateStore \}\)/.test(pi) && /handleScribeRouterSelect\(value, \{ setAppState, store \}\)/.test(src('commands', 'model', 'mercuryModel.tsx')))
check('the helper engages on the router sentinel (incl. the [1m] variant)', /'router-1m'/.test(routerSrc) && /engageScribeSession\(deps\.store\)/.test(routerSrc))
// (window widened 300→600 for the workflows-posture refactor, and the
// probe now ALSO pins the posture clear inside the same exit branch.)
check('the helper disengages when a real model is chosen mid-scribe (and clears the workflows posture)', /isScribeModeOn\(\)[\s\S]{0,600}setImplementerWorkflowsPosture\(false\)[\s\S]{0,300}disengageScribeSession\(deps\.store\)/.test(routerSrc))
check('the carousel scribe engage/disengage block is gone from handleCycleMode', !/nextMode === 'scribe' && toolPermissionContext\.mode !== 'scribe'/.test(pi))

section("substrate: the 'scribe' PermissionMode type/config still exist (inert)")
const types = src('types', 'permissions.ts')
check("InternalPermissionMode still includes 'scribe'", /\|\s*'scribe'/.test(types))
const cfg = src('utils', 'permissions', 'PermissionMode.ts')
check('PERMISSION_MODE_CONFIG still defines scribe (permission-inert)', /scribe:\s*\{[\s\S]{0,280}external:\s*'default'/.test(cfg))

section('router sentinel is a picker ACTION, never a real model (helper + resolution guard)')
const rsel = (await import('../../src/utils/scribe/scribeRouterSelect.js')) as typeof import('../../src/utils/scribe/scribeRouterSelect.js')
const sm = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')
check('classify router sentinel', rsel.classifyScribeRouterModel('__hermes_scribe_router__') === 'router')
check('classify router [1m] variant', rsel.classifyScribeRouterModel('__hermes_scribe_router__[1m]') === 'router-1m')
check('classify workflows sibling', rsel.classifyScribeRouterModel('__hermes_scribe_router_workflows__') === 'workflows')
check('classify a real model', rsel.classifyScribeRouterModel('claude-opus-4-8') === 'model')
check('isScribeRouterSentinel true for router/[1m]/workflows', sm.isScribeRouterSentinel('__hermes_scribe_router__') && sm.isScribeRouterSentinel('__hermes_scribe_router__[1m]') && sm.isScribeRouterSentinel('__hermes_scribe_router_workflows__'))
check('isScribeRouterSentinel false for a real model', !sm.isScribeRouterSentinel('claude-opus-4-8'))
// a bare stamp cannot strip the router. The safe stamp-blind assertion: a REAL model select stays 'not-router' under a bare stamp —
// never drive the sentinel here (it would ENGAGE and spawn the daemon).
setStamp(false)
check('bare stamp: a real model select is not-router (stamp-independent classify)', rsel.handleScribeRouterSelect('claude-opus-4-8', { setAppState: () => {}, store: { getState: () => ({}), setState: () => {} } }) === 'not-router')
setStamp(true)
check('the model RESOLUTION guards the sentinel (self-heal a stuck session)', /isScribeRouterSentinel\(specifiedModel\)/.test(src('utils', 'model', 'model.ts')))

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CAROUSEL PROOFS PASS')
else console.log(`❌ ${failures} CAROUSEL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
