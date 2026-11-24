#!/usr/bin/env bun
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

const home = pinScratchHome('window-records-stamp')
const daemonHome = join(home, 'daemon')
mkdirSync(daemonHome, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.js')
bootstrap.setOriginalCwd(home)
bootstrap.setCwdState(home)
bootstrap.setProjectRoot(home)
const store = await import('../../src/daemon/concourse-workers/store.js')
const { _setEmitReadGateForProofs } = await import('../../src/platform/substrate/fileStore.js')
const vitals = await import('../../src/screen/app-state/vitalsBus.js')

const WHERE = 'a window must learn of a change to the session records from the two-line stamp (subscribeConcourseDelta in src/daemon/concourse-workers/store.ts), never from a watch that reads concourse-workers.json whole: see startEngine in src/screen/app-state/vitalsBus.ts and useWakeGlance in src/screen/fullscreen-layout/HelmLanesRail.tsx'
const PARKED = 300
const WATCH_SETTLE_MS = 1500
const REFRESH_BUDGET_MS = 4000
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${ok ? '' : ` — ${WHERE}`}`)
}
const until = async (predicate: () => boolean, budgetMs: number): Promise<number> => {
  const started = Date.now()
  while (!predicate() && Date.now() - started < budgetMs) await settle(20)
  return Date.now() - started
}

type Records = Parameters<Parameters<typeof store.updateConcourseWorkers>[0]>[0]
type Rec = Records[string]
const sessionOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const record = (n: number, more: Partial<Rec>): Rec => ({ schema: 1, runnerId: `concourse-w${n}`, sessionId: sessionOf(n), workspaceId: `/fixture/project-${n % 7}`, isolation: 'exclusive', modelKey: 'fixture-model', effort: 'high', spawnedAt: 1_000 + n, lastLiveAt: 2_000 + n, title: `session ${n} of the fixture home`, branchName: `mercury/session-${n}`, workspaceKind: 'git', ...more })
const LIVE = PARKED + 1
store.updateConcourseWorkers(workers => {
  for (let n = 1; n <= PARKED; n++) workers[`concourse-w${n}`] = record(n, { parkedAt: 5_000 + n, parkedBy: 'fixture', parkReason: 'quit' })
  workers[`concourse-w${LIVE}`] = record(LIVE, { pid: process.pid })
})
const recordsPath = store.concourseWorkersPath()
const stampPath = store.concourseDeltaPath()
const rowsShown = (): string => JSON.stringify(vitals.getVitals().sessions)
const rowsExpected = (paused: boolean): string => JSON.stringify({ state: 'known', rows: Array.from({ length: LIVE }, (_, at) => ({ sessionId: sessionOf(at + 1), live: at + 1 === LIVE, paused: at + 1 === LIVE && paused, parked: at + 1 !== LIVE, stopped: false })) })

let watchReads = 0
const unsubscribe = vitals.subscribeVitals(() => {}, true)
try {
  await until(() => vitals.getVitals().version > 0, REFRESH_BUDGET_MS)
  check('the window shows the home as it stands: one row a record, the live one live', rowsShown() === rowsExpected(false), `${rowsShown().length} bytes of rows`)
  await settle(WATCH_SETTLE_MS)
  _setEmitReadGateForProofs(async () => { watchReads++ })
  await settle(WATCH_SETTLE_MS)
  check('with nothing written, no watch of the window reads a file', watchReads === 0, `${watchReads} read(s)`)
  console.log(`MEASURE the records file holds ${PARKED + 1} records in ${statSync(recordsPath).size} bytes; the stamp is ${statSync(stampPath).size} bytes`)

  watchReads = 0
  const quiet = vitals.getVitals().version
  const whole = JSON.parse(readFileSync(recordsPath, 'utf8')) as { version: 1; workers: Records }
  whole.workers[`concourse-w${LIVE}`]!.title = 'written past the daemon'
  writeFileSync(recordsPath, `${JSON.stringify(whole, null, 1)}\n`)
  await settle(WATCH_SETTLE_MS)
  console.log(`MEASURE the records file rewritten alone: ${watchReads} whole-file read(s) by the window's watch`)
  check('a rewrite of the records file alone wakes no read of it in the window', watchReads === 0 && vitals.getVitals().version === quiet, `${watchReads} read(s), version ${quiet} → ${vitals.getVitals().version}`)

  watchReads = 0
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as { version: 1; revision: number; pid: number; at: number }
  writeFileSync(stampPath, `${JSON.stringify({ ...stamp, revision: stamp.revision + 1, at: Date.now() })}\n`)
  await until(() => watchReads > 0, REFRESH_BUDGET_MS)
  await settle(300)
  console.log(`MEASURE the stamp rewritten alone: ${watchReads} read(s) by the window's watch, of the ${statSync(stampPath).size}-byte stamp`)
  check('the stamp alone wakes the window: its watch reads the stamp once', watchReads === 1, `${watchReads} read(s)`)

  watchReads = 0
  store.updateConcourseWorkers(workers => {
    workers[`concourse-w${LIVE}`]!.pausedAt = Date.now()
  })
  const shown = await until(() => rowsShown() === rowsExpected(true), REFRESH_BUDGET_MS)
  await settle(300)
  console.log(`MEASURE a save by the daemon's door: the window shows the paused row after ${shown} ms; ${watchReads} read(s) by its watch`)
  check("a save through the daemon's door reaches the window: the paused session reads paused, every other row as it was", rowsShown() === rowsExpected(true), `${shown} ms`)
  check("for that save the window's watch reads one file, the stamp", watchReads === 1, `${watchReads} read(s)`)
} finally {
  _setEmitReadGateForProofs(null)
  unsubscribe()
  releaseScratchHome(home)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
