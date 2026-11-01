#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

const home = pinScratchHome('vitals-live-refresh')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setOriginalCwd(home)
bootstrap.setCwdState(home)
bootstrap.setProjectRoot(home)
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { hasSeatLive } = await import('../../src/services/engine-connector/seatLive.js')
const vitals = await import('../../src/state/vitalsBus.js')

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
setFocusedSessionConnector(connector)
check('the daemon connector offers the seat-live extension the bus subscribes through', hasSeatLive(connector))

let notified = 0
const unsubscribe = vitals.subscribeVitals(() => { notified++ }, true)
try {
  const first = await until(() => vitals.getVitals().version > 0, REFRESH_BUDGET_MS)
  check('subscribing starts the engine and the first refresh lands', vitals.getVitals().version > 0, `${first} ms, version ${vitals.getVitals().version}`)
  await settle(600)
  const settled = vitals.getVitals().version
  const settledNotices = notified
  await settle(QUIET_MS)
  check(`with no change on the focused session the vitals hold still for ${QUIET_MS} ms (the heartbeat is 15 s away)`, vitals.getVitals().version === settled && notified === settledNotices, `version ${settled} → ${vitals.getVitals().version}, notices ${settledNotices} → ${notified}`)

  const before = vitals.getVitals().version
  const beforeAt = Date.now()
  connector.adoptRecord({ ...record, title: 'resumed fixture, runner alive' } as never)
  const waited = await until(() => vitals.getVitals().version > before, REFRESH_BUDGET_MS)
  check('a live change on the focused connector re-reads the vitals within the debounce, not on the heartbeat', vitals.getVitals().version > before && waited < REFRESH_BUDGET_MS, `version ${before} → ${vitals.getVitals().version} after ${waited} ms`)
  check('the refresh reaches the subscribers', notified > settledNotices, `${settledNotices} → ${notified}`)
  check('the refresh is stamped at the live change, not at the subscription', vitals.getVitals().refreshedAt >= beforeAt, `refreshedAt ${vitals.getVitals().refreshedAt} vs ${beforeAt}`)
} finally {
  unsubscribe()
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`vitals-live-refresh: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
