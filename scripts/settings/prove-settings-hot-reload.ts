#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'hotreload-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'hotreload-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/boot/process-state/processState.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])

const { settingsChangeDetector } = await import(
  '../../src/platform/settings/changeDetector.ts'
)
const { markInternalWrite } = await import('../../src/platform/settings/internalWrites.ts')
const { getInitialSettings } = await import('../../src/platform/settings/settings.ts')

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
  console.log('\n❌ TIMEOUT — proof exceeded 90s; the watcher in src/platform/settings/changeDetector.ts (initialize, handleChange, handleUnlink) stopped delivering events')
  process.exit(1)
}, 90_000)
guard.unref?.()

const userPath = join(HOME, 'settings.json')
const projDir = join(PROJ, '.mercury')
mkdirSync(projDir, { recursive: true })
const projPath = join(projDir, 'settings.json')

writeFileSync(userPath, JSON.stringify({ engine: { model: 'initial' } }))
writeFileSync(projPath, JSON.stringify({}))

const events: Array<{ source: string; modelAtNotify: unknown }> = []
await settingsChangeDetector.resetForTesting({
  stabilityThreshold: 60,
  pollInterval: 20,
  deletionGrace: 250,
})
settingsChangeDetector.subscribe(source => {
  events.push({ source, modelAtNotify: getInitialSettings().engine?.model })
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
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'initial' }, __probe: Date.now() }))
  if (!(await waitForEvents(before + 1, 10_000))) {
    console.log('❌ SETTLE PROBE — the watcher never delivered the sentinel edit (watcher not armed); check initialize in src/platform/settings/changeDetector.ts')
    process.exit(1)
  }
  await quiet(5000)
  events.length = 0
}

console.log('============================================================')
console.log(' Settings hot reload — the real watcher, hermetic')
console.log('============================================================')

section('(1) external edit → one notification, fresh truth at notify time')
{
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'externally-changed' } }))
  const fired = await waitForEvents(1)
  check('notification fired for the external edit', fired, `events=${events.length}; handleChange in src/platform/settings/changeDetector.ts should fan out an edit to settings.json`)
  check('source attributed to userSettings', events[0]?.source === 'userSettings', `${JSON.stringify(events[0])}; sourceForPath in src/platform/settings/changeDetector.ts should map the user settings path to userSettings`)
  check(
    'cache was reset BEFORE listeners ran (listener saw the new value)',
    events[0]?.modelAtNotify === 'externally-changed',
    `${JSON.stringify(events[0])}; fanOut in src/platform/settings/changeDetector.ts must call resetSettingsCache before it emits`,
  )
  await waitMs(400)
  check('exactly one notification for one edit', events.length === 1, `${events.length}; handleChange in src/platform/settings/changeDetector.ts should fan out once per edit`)
}

section('(2) internal writes are suppressed')
{
  const before = events.length
  markInternalWrite(userPath)
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'internal-write' } }))
  await waitMs(900)
  check('no notification for the internal write', events.length === before, `events=${events.length - before}; handleChange in src/platform/settings/changeDetector.ts should skip a path marked by markInternalWrite (src/platform/settings/internalWrites.ts)`)
}

section('(3) project-file edit attributes to projectSettings')
{
  const before = events.length
  writeFileSync(projPath, JSON.stringify({ environment: { values: { X: '1' } } }))
  const fired = await waitForEvents(before + 1)
  check('project edit fires', fired, `events=${events.length}; initialize in src/platform/settings/changeDetector.ts should watch the project .mercury/settings.json`)
  check('source is projectSettings', events[before]?.source === 'projectSettings', `${JSON.stringify(events[before])}; sourceForPath in src/platform/settings/changeDetector.ts should map the project settings path to projectSettings`)
}

section('(4) delete-then-recreate inside the grace window collapses to a change')
{
  const before = events.length
  rmSync(userPath)
  await waitMs(80)
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'recreated' } }))
  const fired = await waitForEvents(before + 1)
  check('recreate fired a change notification', fired, `events=${events.length}; handleChange in src/platform/settings/changeDetector.ts should fan out a file recreated after a delete`)
  await waitMs(600)
  check(
    'no double event from the absorbed deletion',
    events.length === before + 1,
    `${events.length - before}; handleChange in src/platform/settings/changeDetector.ts should cancel the pending deletion timer that handleUnlink started`,
  )
  check('listener saw the recreated content', events[before]?.modelAtNotify === 'recreated', `${JSON.stringify(events[before])}; fanOut in src/platform/settings/changeDetector.ts must reset the settings cache before it emits`)
}

section('(5) a real deletion fires after the grace window')
{
  const before = events.length
  rmSync(userPath)
  const fired = await waitForEvents(before + 1, 6000)
  check('deletion notification fired after grace', fired, `events=${events.length}; handleUnlink in src/platform/settings/changeDetector.ts should fan out once its grace timer expires`)
  check('deletion attributed to userSettings', events[before]?.source === 'userSettings', `${JSON.stringify(events[before])}; sourceForPath in src/platform/settings/changeDetector.ts should map the deleted path to userSettings`)
}

section('(6) dispose() stops the watcher')
{
  await settingsChangeDetector.dispose()
  const before = events.length
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'after-dispose' } }))
  await waitMs(700)
  check('no events after dispose', events.length === before, `${events.length - before}; dispose in src/platform/settings/changeDetector.ts should close the watchers`)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SETTINGS HOT-RELOAD JOURNEY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} HOT-RELOAD FAILURE(S)`)
process.exit(1)
