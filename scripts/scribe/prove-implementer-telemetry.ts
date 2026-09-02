#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-implementer-telemetry.ts
//  PROOF (#43 R2b): the Scribe is not BLIND to its daemon-hosted Implementer.
//  A foreground self-armed poll publishes the Implementer's live state (ctx / busy /
//  restarts / wedged) to a module cache; the per-turn awareness reminder reads it SYNC
//  and surfaces it as an internal advisory so the Scribe can route around a near-full /
//  wedged backend and report honestly. Honest by construction (#47): an EMPTY cache (no
//  poll answered yet) does NOT stay silent — silence was the fabrication window (the model
//  filled it with an invented reply) — it POSITIVELY emits "NO confirmed-live Implementer
//  right now", so the Scribe can never claim a reply that has not landed.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-implementer-telemetry.ts
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

const tel = (await import('../../src/utils/scribe/implementerTelemetry.js')) as typeof import('../../src/utils/scribe/implementerTelemetry.js')
const smT = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')

console.log('============================================================')
console.log(' Implementer telemetry — the Scribe is not blind (#43 R2b)')
console.log('============================================================')

section('cache publish/read + the self-armed poll (idempotent, MODE-gated — the carousel path)')
tel.__resetImplementerTelemetryForTests()
check('empty cache ⇒ daemonUp:false (fresh session, nothing polled)', tel.getImplementerTelemetry().daemonUp === false)
tel.publishImplementerTelemetry({ daemonUp: true, present: true, busy: true, contextPct: 50, respawns: 1 })
check('publish then read round-trips', tel.getImplementerTelemetry().busy === true && tel.getImplementerTelemetry().contextPct === 50)
// poll arming gates on the MODE (isScribeModeOn), not the role env — the /model carousel
// engage flips only setScribeMode, never MERCURY_SCRIBE, so a role gate left the poll dead
// on the operator's actual engage path. Drive the gate via setScribeMode (env-independent).
const smArm = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')
const SC = process.env.MERCURY_SCRIBE
smArm.setScribeMode(false)
tel.__resetImplementerTelemetryForTests()
check('scribe mode OFF ⇒ poll does NOT arm (no foreground polling outside the Scribe)', tel.armImplementerTelemetryPoll({ refresh: async () => {} }) === false)
// scribe mode ON ⇒ arms once (idempotent); use an injected refresh so no real RPC/timer churn.
// NOTE: the carousel engage sets NO env — setScribeMode(true) alone must arm it.
smArm.setScribeMode(true)
tel.__resetImplementerTelemetryForTests()
let refreshes = 0
check('scribe MODE on (no role env) ⇒ arms (the carousel engage path)', tel.armImplementerTelemetryPoll({ refresh: async () => void refreshes++ }) === true)
check('a 2nd arm is a no-op (idempotent)', tel.armImplementerTelemetryPoll({ refresh: async () => void refreshes++ }) === false)
smArm.setScribeMode(false)
SC === undefined ? delete process.env.MERCURY_SCRIBE : (process.env.MERCURY_SCRIBE = SC)

section('awareness reminder surfaces the live state — and is positively honest when it has none')
const aware = (await import('../../src/utils/scribe/scribeAwareness.js')) as typeof import('../../src/utils/scribe/scribeAwareness.js')
smT.setScribeMode(true) // engage — the builder gates on the MODE, not the role env
tel.publishImplementerTelemetry({ daemonUp: true, present: true, busy: true, contextPct: 78, respawns: 2 })
const busyR = aware.buildScribeAwarenessReminder([])
check('busy backend ⇒ MID-TASK line w/ ctx + restarts + hold guidance', /MID-TASK/.test(busyR) && /context ~78%/.test(busyR) && /2 restarts/.test(busyR) && /one at a time/.test(busyR))
tel.publishImplementerTelemetry({ daemonUp: true, present: true, busy: false, contextPct: 88 })
const idleR = aware.buildScribeAwarenessReminder([])
check('idle + near-full ⇒ IDLE line + auto-clear note', /IDLE/.test(idleR) && /near full/.test(idleR) && /auto-clears/.test(idleR))
tel.publishImplementerTelemetry({ daemonUp: true, present: false })
const wedgedR = aware.buildScribeAwarenessReminder([])
check('daemon up but no live Implementer ⇒ honest "no confirmed-live / cannot take execution" line', /NO confirmed-live Implementer right now/.test(wedgedR) && /cannot take execution/.test(wedgedR))
tel.__resetImplementerTelemetryForTests()
const emptyR = aware.buildScribeAwarenessReminder([])
// #47 fabrication fix: an EMPTY cache no longer stays silent (that silence was the window the
// model filled with an invented reply) — it POSITIVELY says there is no confirmed-live backend.
check('EMPTY cache ⇒ POSITIVELY honest "no confirmed-live" line (silence was the fabrication window)', /Backend state/.test(emptyR) && /NO confirmed-live Implementer right now/.test(emptyR))
smT.setScribeMode(false)

section('wiring (structural)')
const qe = src('QueryEngine.ts')
check('QueryEngine arms the telemetry poll at Scribe startup', /armImplementerTelemetryPoll\(\)/.test(qe))
const aw = src('utils', 'scribe', 'scribeAwareness.ts')
check('awareness reads the telemetry cache, gated on the live bus', /getImplementerTelemetry\(\)/.test(aw) && /if \(scribeBusLiveEnabled\(\)\) \{[\s\S]{0,400}getImplementerTelemetry\(\)/.test(aw))
const tl = src('utils', 'scribe', 'implementerTelemetry.ts')
check('the poll is unref-d + self-gating on the MODE (isScribeModeOn — arms on the carousel engage, not just the role env)', /\.unref\?\.\(\)/.test(tl) && /scribeModeEnabled\(\) && isScribeModeOn\(\)/.test(tl) && !/scribeModeEnabled\(\) && isScribeRole\(\)/.test(tl))
check('telemetry reads the honest daemonRosterSnapshot (never throws / no fabrication)', /daemonRosterSnapshot\('implementer'\)/.test(tl))

// Interactive wiring-gap fix (audit-cycle-1): the poll was armed ONLY on the headless
// QueryEngine path, so the interactive REPL Scribe stayed permanently blind — the awareness
// reminder read "NO confirmed-live Implementer / cannot take execution on" every turn even
// with a live daemon. engageScribeTeam — run by BOTH interactive entry points (REPL mount +
// scribeRouterSelect) AND the headless path — now arms it too (idempotent + scribe-mode-gated).
// THE CAROUSEL PATH (the bug this section must CATCH, not green-lock): the operator's /model
// engage flips only setScribeMode, never MERCURY_SCRIBE — so engage via the MODE with the role
// env DELETED. Manufacturing MERCURY_SCRIBE=1 here would mask whether the carousel path arms.
section('interactive engage arms the poll on the CAROUSEL path (mode-driven, NO role env)')
const teamSrc = src('utils', 'scribe', 'engageScribeTeam.ts')
check('engageScribeTeam imports + calls armImplementerTelemetryPoll (structural)', /import \{ armImplementerTelemetryPoll \}/.test(teamSrc) && /armImplementerTelemetryPoll\(\)/.test(teamSrc))
smArm.setScribeMode(true) // the carousel engage lever (no role env) — this is what must arm the poll
delete process.env.MERCURY_SCRIBE_BUS_LIVE // default ON ⇒ engageScribeTeam does not early-return
const team = (await import('../../src/utils/scribe/engageScribeTeam.js')) as typeof import('../../src/utils/scribe/engageScribeTeam.js')
tel.__resetImplementerTelemetryForTests()
team.__resetScribeTeamStash()
team.engageScribeTeam({ getState: () => ({}), setState: () => {} })
check('engageScribeTeam() actually armed the poll on the carousel path (functional — a subsequent arm is a no-op)', tel.armImplementerTelemetryPoll({ refresh: async () => {} }) === false)
team.__resetScribeTeamStash()
tel.__resetImplementerTelemetryForTests()
smArm.setScribeMode(false)
SC === undefined ? delete process.env.MERCURY_SCRIBE : (process.env.MERCURY_SCRIBE = SC)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL IMPLEMENTER-TELEMETRY PROOFS PASS')
else console.log(`❌ ${failures} IMPLEMENTER-TELEMETRY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
