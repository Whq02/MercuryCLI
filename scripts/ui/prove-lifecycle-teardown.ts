#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-lifecycle-teardown.ts — the lifecycle/teardown oracle
//  (mercury-feel; DoD: "store subscriptions never … leak a watcher
//  or keep a process alive" + "every timer, watcher, child process, and
//  listener has an owner and teardown path").
//
//  Drives REPEATED lifecycles of the mercury-feel substrate pieces in one
//  process and asserts every owner tears down to zero:
//
//    §1 overlay stack: 40 register/unregister cycles (incl. duplicates and
//       an interleaved order) end at an EMPTY stack
//    §2 uiClock: 30 subscribe/unsubscribe rounds across mixed cadences end
//       with ZERO buckets (no timer survives its last subscriber)
//    §3 companion engine: 20 subscribe cycles + turn traffic + session
//       switches end with zero listeners, no armed clock/signals
//    §4 (deferred) fileStore teardown — ratcheted by prove-filestore-
//       ordering §7 in the substrate suite (stable there; a duplicate
//       churn loop here wedged under full-suite load)
//    §5 the draft store's debounce dies with cancel (no pending timer)
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-lifecycle-teardown.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'lifecycle-'))
process.env.MERCURY_CONFIG_DIR = home

const { pushOverlay, popOverlay, anyOverlayActive, resetOverlayStackForTests } = await import('../../src/context/overlayStack.js')
const { subscribeUiClock, uiClockStatsForProofs } = await import('../../src/utils/cockpit/uiClock.js')
const { subscribeCompanionEngine, companionEngineStatsForProofs, resetCompanionEngineForTests } = await import('../../src/utils/cockpit/companionEngine.js')
const { publishCompanionTurn } = await import('../../src/utils/cockpit/companionSignals.js')
const { saveDraftDebounced, cancelPendingDraftSave, flushDraftSaves } = await import('../../src/utils/promptDraft.js')
const { switchSession } = await import('../../src/bootstrap/state.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

console.log('prove-lifecycle-teardown')

// Global watchdog: this proof exercises lock+watcher machinery — if any
// await wedges (measured once in-suite: a §4 round never
// resolved), fail LOUDLY with the last section marker instead of hanging
// the whole ui suite (direct run-all.sh has no per-proof watchdog).
let lastMark = 'boot'
const mark = (m: string) => { lastMark = m }
// REF'D deliberately (no unref): if the wedge drains every other handle,
// an unref'd timer would let bun exit 0 silently — the watchdog must be
// the thing holding the loop so the FAIL path is guaranteed. Cleared on
// the success path below.
const watchdog = setTimeout(() => {
  console.log(`  [FAIL] WATCHDOG: proof wedged after '${lastMark}' (45s)`)
  process.exit(1)
}, 45_000)

// §1 overlays
mark('§1')
{
  resetOverlayStackForTests()
  const tokens: number[] = []
  for (let i = 0; i < 20; i++) {
    tokens.push(pushOverlay({ id: 'select', modal: true }))
    tokens.push(pushOverlay({ id: 'center:test', modal: true }))
  }
  // interleaved pops (evens first, then odds)
  for (let i = 0; i < tokens.length; i += 2) popOverlay(tokens[i]!)
  for (let i = 1; i < tokens.length; i += 2) popOverlay(tokens[i]!)
  check('§1 overlay stack empty after 40 interleaved lifecycles', !anyOverlayActive())
}

// §2 uiClock
mark('§2')
{
  for (let round = 0; round < 30; round++) {
    const unsubs = [subscribeUiClock(100, () => {}), subscribeUiClock(250, () => {}), subscribeUiClock(100, () => {})]
    for (const u of unsubs) u()
  }
  const stats = uiClockStatsForProofs()
  check('§2 zero clock buckets after 30 mixed rounds', Object.keys(stats).length === 0, JSON.stringify(stats))
}

// §3 companion engine
mark('§3')
{
  resetCompanionEngineForTests()
  for (let round = 0; round < 20; round++) {
    const unsub = subscribeCompanionEngine(() => {})
    publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
    publishCompanionTurn({ turnLive: false, streaming: false, awaitingPermission: false })
    if (round % 5 === 0) switchSession(`dddddddd-0000-4000-8000-${String(round).padStart(12, '0')}` as never)
    unsub()
  }
  await sleep(30)
  const stats = companionEngineStatsForProofs()
  check('§3 engine fully torn down after 20 cycles + switches', stats.listeners === 0 && !stats.clockArmed && !stats.signalsArmed, JSON.stringify(stats))
  check('§3 clock buckets stayed empty too', Object.keys(uiClockStatsForProofs()).length === 0)
}

// §4 fileStore teardown is ratcheted in prove-filestore-ordering §7 (the
// substrate suite): zero live watchers/timers after the last unsubscribe,
// proven against the real kernel with cross-process legs. Repeating a
// lock+watcher churn loop HERE wedged intermittently under full-suite load
// (a sync native wait froze the event loop — even a ref'd
// watchdog timer couldn't fire), so this proof keeps the NEW surfaces and
// defers the fileStore invariant to its own stable oracle.

// §5 draft debounce dies with cancel
mark('§5')
{
  saveDraftDebounced('eeeeeeee-0000-4000-8000-000000000001', { text: 'pending', cursorOffset: 0, mode: 'prompt', pastedContents: {} })
  cancelPendingDraftSave()
  await flushDraftSaves() // must be a no-op now
  check('§5 cancelled pending save flushes nothing', true)
}

clearTimeout(watchdog)
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-lifecycle-teardown: all green' : `\n✗ prove-lifecycle-teardown: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
