#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-settings-hot-reload.ts — the settings hot-reload
//  journey (core-ownership Phase 2 — closes the ONE uncovered journey in the
//  Phase 0 coverage map).
//
//  Drives the REAL changeDetector (chokidar watcher) over a hermetic config
//  home + project dir with fast test thresholds. Pins:
//    · an external edit to user settings fires exactly one notification with
//      the right source, the cache is reset BEFORE listeners run (one
//      notification = fresh disk truth for every subscriber);
//    · an INTERNAL write (markInternalWrite → write) is suppressed;
//    · delete-then-recreate within the grace window collapses to a CHANGE
//      (no spurious deletion handling);
//    · a real deletion fires after the grace window;
//    · project-file edits attribute to projectSettings;
//    · dispose() stops the watcher (no events after).
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-settings-hot-reload.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'hotreload-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'hotreload-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])

const { settingsChangeDetector } = await import(
  '../../src/utils/settings/changeDetector.ts'
)
const { markInternalWrite } = await import('../../src/utils/settings/internalWrites.ts')
const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const waitMs = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const userPath = join(HOME, 'settings.json')
// Canonical home: the settings resolver adopts legacy
// homes forward and watches the .mercury path — stage there directly.
const projDir = join(PROJ, '.mercury')
mkdirSync(projDir, { recursive: true })
const projPath = join(projDir, 'settings.json')

// Files must exist BEFORE initialize() — only dirs with ≥1 existing settings
// file are watched.
writeFileSync(userPath, JSON.stringify({ model: 'initial' }))
writeFileSync(projPath, JSON.stringify({}))

const events: Array<{ source: string; modelAtNotify: unknown }> = []
await settingsChangeDetector.resetForTesting({
  stabilityThreshold: 60,
  pollInterval: 20,
  deletionGrace: 250,
})
settingsChangeDetector.subscribe(source => {
  // The contract: fanOut resets the cache BEFORE emitting, so a listener
  // reading settings sees the fresh disk truth.
  events.push({ source, modelAtNotify: getInitialSettings().model })
})
await settingsChangeDetector.initialize()

async function waitForEvents(n: number, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (events.length >= n) return true
    await waitMs(40)
  }
  return events.length >= n
}

// ── OBSERVED-READY SETTLE
// The two settings files are written milliseconds before initialize(), and
// macOS FSEvents' since-now watermark can miss a not-yet-journaled write —
// the pre-watch write then REPLAYS as a change event after the watcher arms,
// so a fixed arm-wait intermittently leaks a spurious projectSettings/
// userSettings event into section (1). Settle by observation instead:
//   1. drain until a continuous quiet window absorbs any startup replay,
//   2. prove the watcher is ARMED with a sentinel edit whose event we AWAIT
//      (never delivered ⇒ loud FAIL — that is a real watcher regression),
//   3. drain the sentinel's tail, then zero the ledger for the sections.
{
  const QUIET_MS = 400
  const quiet = async (maxMs: number): Promise<void> => {
    const t0 = Date.now()
    let seen = events.length
    let quietSince = Date.now()
    while (Date.now() - t0 < maxMs) {
      if (events.length !== seen) {
        console.log(`  (settle: drained a startup-replay event ${JSON.stringify(events[events.length - 1]?.source)})`)
        seen = events.length
        quietSince = Date.now()
      }
      if (Date.now() - quietSince >= QUIET_MS) return
      await waitMs(40)
    }
  }
  await quiet(5000)
  const before = events.length
  writeFileSync(userPath, JSON.stringify({ model: 'initial', __probe: Date.now() }))
  if (!(await waitForEvents(before + 1, 10_000))) {
    console.log('❌ SETTLE PROBE — the watcher never delivered the sentinel edit (watcher not armed)')
    process.exit(1)
  }
  await quiet(5000)
  events.length = 0
}

console.log('============================================================')
console.log(' Settings hot reload — the real watcher, hermetic')
console.log('============================================================')

//
section('(1) external edit → one notification, fresh truth at notify time')
{
  writeFileSync(userPath, JSON.stringify({ model: 'externally-changed' }))
  const fired = await waitForEvents(1)
  check('notification fired for the external edit', fired, `events=${events.length}`)
  check('source attributed to userSettings', events[0]?.source === 'userSettings', JSON.stringify(events[0]))
  check(
    'cache was reset BEFORE listeners ran (listener saw the new value)',
    events[0]?.modelAtNotify === 'externally-changed',
    JSON.stringify(events[0]),
  )
  await waitMs(400)
  check('exactly one notification for one edit', events.length === 1, String(events.length))
}

//
section('(2) internal writes are suppressed')
{
  const before = events.length
  markInternalWrite(userPath)
  writeFileSync(userPath, JSON.stringify({ model: 'internal-write' }))
  await waitMs(900) // stability window + margin
  check('no notification for the internal write', events.length === before, `events=${events.length - before}`)
}

//
section('(3) project-file edit attributes to projectSettings')
{
  const before = events.length
  writeFileSync(projPath, JSON.stringify({ env: { X: '1' } }))
  const fired = await waitForEvents(before + 1)
  check('project edit fires', fired, `events=${events.length}`)
  check('source is projectSettings', events[before]?.source === 'projectSettings', JSON.stringify(events[before]))
}

//
section('(4) delete-then-recreate inside the grace window collapses to a change')
{
  const before = events.length
  rmSync(userPath)
  await waitMs(80) // < deletionGrace (250ms)
  writeFileSync(userPath, JSON.stringify({ model: 'recreated' }))
  const fired = await waitForEvents(before + 1)
  check('recreate fired a change notification', fired, `events=${events.length}`)
  await waitMs(600)
  check(
    'no double event from the absorbed deletion',
    events.length === before + 1,
    String(events.length - before),
  )
  check('listener saw the recreated content', events[before]?.modelAtNotify === 'recreated', JSON.stringify(events[before]))
}

//
section('(5) a real deletion fires after the grace window')
{
  const before = events.length
  rmSync(userPath)
  const fired = await waitForEvents(before + 1, 6000)
  check('deletion notification fired after grace', fired, `events=${events.length}`)
  check('deletion attributed to userSettings', events[before]?.source === 'userSettings', JSON.stringify(events[before]))
}

//
section('(6) dispose() stops the watcher')
{
  await settingsChangeDetector.dispose()
  const before = events.length
  writeFileSync(userPath, JSON.stringify({ model: 'after-dispose' }))
  await waitMs(700)
  check('no events after dispose', events.length === before, String(events.length - before))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SETTINGS HOT-RELOAD JOURNEY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} HOT-RELOAD FAILURE(S)`)
process.exit(1)
