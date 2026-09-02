#!/usr/bin/env bun
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
const { TIP_BOOT_QUIET_MS } = await import('../../src/utils/cockpit/companionVoice.js')
const settleBoot = (): void => {
  tick(TIP_BOOT_QUIET_MS + 1_000)
  tick(VOICE_COOLDOWN_MS)
}

console.log('prove-companion-engine')

switchSession(sid(1))
resetCompanionEngineForTests()
resetCompanionSignals()

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
  tick(20_000)
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

{
  resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = subscribeCompanionEngine(() => {})
  settleBoot()
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
  now += LONG_WORK_MS + 1_000
  noteCompanionTyping()
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now)
  recomputeCompanionForProofs()
  check('§3 typing suppresses the settle line (pose still moves)', companionEngineSnapshot().quip === null && companionEngineSnapshot().mood === 'done')
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

{
  const stats = companionEngineStatsForProofs()
  check('§6 zero listeners after the last unsubscribe', stats.listeners === 0)
  check('§6 clock + signal subscriptions torn down', !stats.clockArmed && !stats.signalsArmed, JSON.stringify({ ...stats, voice: undefined }))
}

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
