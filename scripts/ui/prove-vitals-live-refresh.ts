#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

const home = pinScratchHome('vitals-live-refresh')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.js')
bootstrap.setOriginalCwd(home)
bootstrap.setCwdState(home)
bootstrap.setProjectRoot(home)
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { hasSeatLive } = await import('../../src/engine/connector/seatLive.js')
const vitals = await import('../../src/screen/app-state/vitalsBus.js')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
async function until(predicate: () => boolean, budgetMs: number): Promise<number> {
  const started = Date.now()
  while (!predicate() && Date.now() - started < budgetMs) await settle(20)
  return Date.now() - started
}

const QUIET_MS = 1500
const REFRESH_BUDGET_MS = 4000
const record = { sessionId: randomUUID(), runnerId: 'fixture', title: 'resumed fixture', projectLabel: 'fixture', workspaceId: 'fixture', home }
const connector = new DaemonSessionConnector(record)
connector.workspace = () => ({ cwd: home, projectRoot: home }) as ReturnType<typeof connector.workspace>
let roster: ReturnType<typeof connector.workRoster> = { rows: [], mission: [] }
let rosterReads = 0
connector.workRoster = () => { rosterReads++; return roster }
setFocusedSessionConnector(connector)
check('the daemon connector offers the seat-live extension the bus subscribes through', hasSeatLive(connector), 'DaemonSessionConnector in src/engine/connector/daemonConnector.ts must satisfy hasSeatLive from src/engine/connector/seatLive.ts (subscribeLive)')

let notified = 0
const unsubscribe = vitals.subscribeVitals(() => { notified++ }, true)
try {
  const first = await until(() => vitals.getVitals().version > 0, REFRESH_BUDGET_MS)
  check('subscribing starts the engine and the first refresh lands', vitals.getVitals().version > 0, `${first} ms, version ${vitals.getVitals().version}; subscribeVitals in src/screen/app-state/vitalsBus.ts must start a refresh for the focused connector and publish a snapshot`)
  await settle(600)
  const settled = vitals.getVitals().version
  const settledNotices = notified
  await settle(QUIET_MS)
  check(`with no change on the focused session the vitals hold still for ${QUIET_MS} ms (the heartbeat is 15 s away)`, vitals.getVitals().version === settled && notified === settledNotices, `version ${settled} → ${vitals.getVitals().version}, notices ${settledNotices} → ${notified}; src/screen/app-state/vitalsBus.ts must publish only when a reading changed`)

  const standing = vitals.getVitals()
  const readBeforeNoise = rosterReads
  connector.adoptRecord({ ...record, title: 'same readings, live notification' })
  await until(() => rosterReads > readBeforeNoise, REFRESH_BUDGET_MS)
  await settle(300)
  check('a live notification still re-reads the sources when their values stay the same', rosterReads > readBeforeNoise, 'a live notification from the focused connector (adoptRecord in src/engine/connector/daemonConnector.ts) must trigger a refresh in src/screen/app-state/vitalsBus.ts that reads workRoster')
  check('unchanged readings keep the snapshot, timestamp and version without notifying', vitals.getVitals() === standing && notified === settledNotices, `version ${standing.version} → ${vitals.getVitals().version}, notices ${settledNotices} → ${notified}; the refresh in src/screen/app-state/vitalsBus.ts must keep the current snapshot when the readings are equal`)
  const readBeforePoke = rosterReads
  vitals.pokeVitals()
  await until(() => rosterReads > readBeforePoke, REFRESH_BUDGET_MS)
  await settle(300)
  check('a heartbeat refresh with the same readings also stays silent', rosterReads > readBeforePoke && vitals.getVitals() === standing && notified === settledNotices, 'pokeVitals in src/screen/app-state/vitalsBus.ts must re-read the sources and keep the snapshot and subscribers silent when the readings are equal')

  const before = vitals.getVitals().version
  const beforeAt = Date.now()
  roster = { rows: [], mission: [{ id: 'resumed-task', subject: 'Resumed task', status: 'in_progress' }] }
  connector.adoptRecord({ ...record, title: 'resumed fixture, runner alive' })
  const waited = await until(() => vitals.getVitals().tasks.some(task => task.id === 'resumed-task'), REFRESH_BUDGET_MS)
  check('a live change on the focused connector publishes the changed reading within the debounce, not on the heartbeat', vitals.getVitals().tasks.some(task => task.id === 'resumed-task') && vitals.getVitals().version === before + 1 && waited < REFRESH_BUDGET_MS, `version ${before} → ${vitals.getVitals().version} after ${waited} ms; src/screen/app-state/vitalsBus.ts must refresh on the focused connector live notification and publish one new version`)
  check('the changed reading reaches the subscribers once', notified === settledNotices + 1, `${settledNotices} → ${notified}; src/screen/app-state/vitalsBus.ts must notify subscribers once per published change`)
  check('the refresh is stamped at the live change, not at the subscription', vitals.getVitals().refreshedAt >= beforeAt, `refreshedAt ${vitals.getVitals().refreshedAt} vs ${beforeAt}; src/screen/app-state/vitalsBus.ts must stamp refreshedAt when the refresh publishes`)
  const changed = vitals.getVitals()
  const changedNotices = notified
  const readBeforeEqual = rosterReads
  roster = { rows: [], mission: roster.mission.map(task => ({ ...task })) }
  connector.adoptRecord({ ...record, title: 'equal readings in fresh objects' })
  await until(() => rosterReads > readBeforeEqual, REFRESH_BUDGET_MS)
  await settle(300)
  check('equal fresh objects retain the published task array and snapshot', rosterReads > readBeforeEqual && vitals.getVitals() === changed && vitals.getVitals().tasks === changed.tasks && notified === changedNotices, 'src/screen/app-state/vitalsBus.ts must compare readings by value and keep the published snapshot and tasks array when fresh objects are equal')
} finally {
  unsubscribe()
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`vitals-live-refresh: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
