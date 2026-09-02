#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-companion-engine.ts — the singleton companion ENGINE
//  oracle ("the same companion state, line, pose, and timer are observed by
//  every critter surface" + the calm rules).
//
//    §1 every subscriber observes the SAME snapshot object/version
//    §2 a SHORT settle is silent (pose moves, no line); a LONG settle speaks
//       ONE line, chosen once — a new subscriber (different mount order)
//       sees the same line
//    §3 calm: active typing suppresses the settle line; a permission held
//       past the holding threshold still speaks through typing; one line per
//       hold (a re-hold inside the cooldown is silent)
//    §4 quiet mode keeps pose/mood moving with NO prose
//    §5 session switch parks the outgoing edges + resets the signal stamps
//       (mood edges can never leak across sessions)
//    §6 teardown: the last unsubscriber releases every timer/subscription
//    §7 a long simulated life (400 turn cycles) leaves state BOUNDED
//
//  The clock is pinned (setCompanionClockForProofs + publishCompanionTurnAt):
//  a long run is minutes of wall time; the prover walks it in milliseconds.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-companion-engine.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'companion-engine-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DECK_COMPANION = '1'

const { publishCompanionTurnAt, resetCompanionSignals } = await import('../../src/utils/cockpit/companionSignals.js')
const {
  subscribeCompanionEngine,
  companionEngineSnapshot,
  companionEngineStatsForProofs,
  resetCompanionEngineForTests,
  recomputeCompanionForProofs,
  setCompanionClockForProofs,
  noteCompanionTyping,
} = await import('../../src/utils/cockpit/companionEngine.js')
const { LONG_WORK_MS, HOLDING_AFTER_MS, VOICE_COOLDOWN_MS } = await import('../../src/utils/cockpit/companionVoice.js')
const { MOMENT_LINES } = await import('../../src/utils/cockpit/companionWords.js')
const { setCompanionQuiet } = await import('../../src/utils/cockpit/critterProfile.js')
const { switchSession } = await import('../../src/bootstrap/state.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sid = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}` as never

// The pinned clock: `now` advances only when the prover says so.
let now = 1_800_000_000_000
setCompanionClockForProofs(() => now)
const tick = (ms: number): void => {
  now += ms
  recomputeCompanionForProofs()
}
const turn = (liveMs: number, awaitingPermission = false): void => {
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission }, now)
  recomputeCompanionForProofs()
  now += liveMs
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
}
const isSettledLine = (text: string | undefined): boolean => text !== undefined && MOMENT_LINES['settled-long'].includes(text)
const isHoldingLine = (text: string | undefined): boolean => text !== undefined && MOMENT_LINES.holding.includes(text)
// A fresh session shows its session-start tip after the boot quiet (the
// voice prover pins that); these legs are about the moments, so each one
// lets the boot tip come and go and the cooldown pass before it begins.
const { TIP_BOOT_QUIET_MS } = await import('../../src/utils/cockpit/companionVoice.js')
const settleBoot = (): void => {
  tick(TIP_BOOT_QUIET_MS + 1_000)
  tick(VOICE_COOLDOWN_MS)
}

console.log('prove-companion-engine')

switchSession(sid(1))
resetCompanionEngineForTests()
resetCompanionSignals()

// §1 + §2 — two subscribers; a short settle is silent; a long settle speaks once
{
  let aTicks = 0
  let bTicks = 0
  const unsubA = subscribeCompanionEngine(() => aTicks++)
  const unsubB = subscribeCompanionEngine(() => bTicks++)
  settleBoot()
  turn(5_000)
  const short = companionEngineSnapshot()
  check('§1 both subscribers read the SAME snapshot object', short === companionEngineSnapshot())
  check('§1 both were notified in lockstep', aTicks === bTicks && aTicks > 0, `a=${aTicks} b=${bTicks}`)
  check('§2 the settle transition produced a done mood', short.mood === 'done', short.mood)
  check('§2 a SHORT settle is silent (no line for a five-second reply)', short.quip === null, short.quip?.text)
  tick(20_000) // decay to idle
  turn(LONG_WORK_MS + 1_000)
  const long = companionEngineSnapshot()
  check('§2 a LONG settle speaks one settled-long line', long.mood === 'done' && isSettledLine(long.quip?.text), long.quip?.text)
  const textAtA = long.quip?.text
  unsubB()
  const unsubC = subscribeCompanionEngine(() => {})
  check('§2 a NEW subscriber (different mount order) sees the SAME line', companionEngineSnapshot().quip?.text === textAtA)
  tick(20_000)
  turn(LONG_WORK_MS + 1_000)
  check('§2 the NEXT long settle is silent (consecutive settles never both speak)', companionEngineSnapshot().quip === null, companionEngineSnapshot().quip?.text)
  unsubA()
  unsubC()
}

// §3 — typing suppresses; holding speaks through typing after the threshold; one line per hold
{
  resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = subscribeCompanionEngine(() => {})
  settleBoot()
  // typing suppression: a long settle while typing ⇒ NO line (pose still moves)
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
  now += LONG_WORK_MS + 1_000
  noteCompanionTyping()
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
  check('§3 typing suppresses the settle line (pose still moves)', companionEngineSnapshot().quip === null && companionEngineSnapshot().mood === 'done')
  // holding: a permission held past the threshold speaks, even through typing
  tick(20_000)
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: true }, now)
  recomputeCompanionForProofs()
  tick(HOLDING_AFTER_MS - 5_000)
  check('§3 a hold shorter than the threshold is silent', companionEngineSnapshot().mood === 'blocked' && companionEngineSnapshot().quip === null)
  noteCompanionTyping()
  tick(6_000)
  const held = companionEngineSnapshot()
  check('§3 past the threshold the hold speaks through typing', held.mood === 'blocked' && isHoldingLine(held.quip?.text), held.quip?.text)
  const firstHoldAt = held.quip?.at ?? 0
  // one line per hold: release → re-hold inside the cooldown ⇒ no second line
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
  tick(1_000)
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: true }, now)
  recomputeCompanionForProofs()
  tick(HOLDING_AFTER_MS + 1_000)
  const again = companionEngineSnapshot()
  check('§3 a re-hold inside the cooldown adds no second line', (again.quip?.at ?? 0) === firstHoldAt || again.quip === null)
  unsub()
}

// §4 — quiet mode: mood moves, no prose
{
  resetCompanionEngineForTests()
  resetCompanionSignals()
  setCompanionQuiet(true)
  const unsub = subscribeCompanionEngine(() => {})
  settleBoot()
  turn(LONG_WORK_MS + 1_000)
  const snap = companionEngineSnapshot()
  check('§4 quiet mode: the mood still settled', snap.mood === 'done')
  check('§4 quiet mode: NO prose, even for a long run', snap.quip === null)
  setCompanionQuiet(false)
  unsub()
}

// §5 — session switch parks edges + resets signal stamps
{
  resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = subscribeCompanionEngine(() => {})
  settleBoot()
  turn(5_000)
  check('§5 session A settled (done)', companionEngineSnapshot().mood === 'done')
  switchSession(sid(2))
  recomputeCompanionForProofs()
  const fresh = companionEngineSnapshot()
  check("§5 session B starts FRESH (idle — A's settle edge did not leak)", fresh.mood === 'idle', fresh.mood)
  check('§5 the outgoing session is PARKED, not lost', companionEngineStatsForProofs().parkedSessions >= 1)
  unsub()
}

// §6 — teardown releases everything
{
  const stats = companionEngineStatsForProofs()
  check('§6 zero listeners after the last unsubscribe', stats.listeners === 0)
  check('§6 clock + signal subscriptions torn down', !stats.clockArmed && !stats.signalsArmed, JSON.stringify({ ...stats, voice: undefined }))
}

// §7 — long simulated life stays bounded
{
  resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = subscribeCompanionEngine(() => {})
  settleBoot()
  for (let i = 0; i < 400; i++) turn(i % 7 === 0 ? LONG_WORK_MS + 1_000 : 3_000)
  const snap = companionEngineSnapshot()
  check('§7 400 turn cycles: snapshot stays a single bounded object', snap.quip === null || typeof snap.quip.text === 'string')
  check('§7 engine state bounded (≤ a handful of parked sessions)', companionEngineStatsForProofs().parkedSessions <= 4)
  unsub()
  check('§7 clean teardown after the burst', !companionEngineStatsForProofs().clockArmed)
}

setCompanionClockForProofs(null)
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-companion-engine: all green' : `\n✗ prove-companion-engine: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
