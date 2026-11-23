#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'health-signin-refresh-'))
Object.assign(process.env, { HOME: scratch, MERCURY_CONFIG_DIR: scratch, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(scratch, 'daemon') })
delete process.env.MERCURY_HOME
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MERCURY_OAUTH_TOKEN']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const signIns = await import('../../src/daemon/session-seat/signInView.ts')
const composeActual = signIns.composeSignInView
const modelLists = await import('../../src/models/roads/typedModelIds.ts')
const control = await import('../../src/daemon/control/controlSocket.ts')
const snapshot = await import('../../src/screen/cockpit-gauges/daemonSnapshot.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
const view = (credentialed: boolean) => ({ home: scratch, store: 'plaintext', readAt: Date.now(), refreshed: true, defaultFamily: credentialed ? 'openai' : null, families: [{ family: 'openai', credentialed, usable: credentialed, ...(credentialed ? { row: 'fixture-model' } : {}) }] })
const readAt = Date.now() - 1000
let catalogue = false
let daemonAt = readAt - 60_000
let refused = false
let present = true
let differentHome = false
let requestedRefresh = false
let clientRefresh = false
mock.module('../../src/daemon/control/controlSocket.ts', () => ({ ...control, daemonControlRpc: async (request: { op: string; refresh?: boolean }) => {
  if (request.op !== 'signIns') return { ok: false, code: 'fixture' }
  requestedRefresh = request.refresh === true
  const daemonView = view(catalogue ? present : requestedRefresh && present)
  if (catalogue) daemonView.families = [{ family: 'openai', credentialed: present, usable: false, catalogueReadAt: daemonAt, ...(refused ? { refused: { status: 401, at: readAt } } : {}) }] as never
  return { ok: true, view: { ...daemonView, ...(differentHome ? { home: join(scratch, 'other') } : {}) } }
} }))
mock.module('../../src/daemon/session-seat/signInView.ts', () => ({ ...signIns, composeSignInView: (opts?: { refresh?: boolean }) => { clientRefresh = opts?.refresh === true; const client = view(true); if (catalogue) Object.assign(client.families[0]!, { catalogueReadAt: readAt }); return client } }))
mock.module('../../src/screen/cockpit-gauges/daemonSnapshot.ts', () => ({ ...snapshot, daemonSnapshot: () => ({ state: 'live', reason: 'fixture daemon' }) }))
const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
let failures = 0
const check = (name: string, ok: boolean, row: unknown, hint?: string): void => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(row)}`); if (!ok && hint) console.log(`  to fix: ${hint}`) }
const read = async () => {
  requestedRefresh = false
  clientRefresh = false
  const report = await runWithCwdOverride(scratch, () => runHealthReport())
  return report.sections.flatMap(section => section.checks).find(row => row.id === 'daemon-sign-ins')
}
try {
  const fresh = await read()
  check('health refreshes both views instead of failing the older cached view', fresh?.status === 'ok' && requestedRefresh && clientRefresh, fresh, 'daemonSignInsCheck in src/platform/health/sections/crew/daemon.ts must send signIns with refresh: true and call composeSignInView({ refresh: true }) before comparing the two views')
  catalogue = true
  const older = await read()
  check('only an older daemon model list is information with its age', older?.status === 'info' && /daemon list read \d+[smhd] ago/.test(older.evidence), older, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) the olderLists branch must return status info with evidence naming the daemon list age when only the daemon catalogueReadAt is older')
  console.log('refusals')
  daemonAt = readAt
  const current = await read()
  check('current conflicting lists remain a failure', current?.status === 'fail', current, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) a gap whose daemon list is not older than the client list must fall through to the fail result')
  daemonAt = Number.NaN
  const unknown = await read()
  check('an unknown list age cannot disguise a disagreement', unknown?.status === 'fail', unknown, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) olderLists must skip a daemonAt that is not a finite number above 0, so the gap stays a fail')
  daemonAt = readAt - 60_000
  refused = true
  const refusal = await read()
  check('a sign-in refusal is not hidden by an older list', refusal?.status === 'fail', refusal, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) olderLists must skip a family whose client or daemon row carries refused, so the gap stays a fail')
  refused = false
  present = false
  const missing = await read()
  check('a family still missing after refresh remains a failure', missing?.status === 'fail' && /openai/.test(missing.evidence), missing, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) a family credentialed on the client and not on the daemon must stay a fail whose evidence names the family')
  present = true
  differentHome = true
  const split = await read()
  check('a different credential home remains a failure after refresh', split?.status === 'fail', split, 'in daemonSignInsCheck (src/platform/health/sections/crew/daemon.ts) sameEstate compares view.home and view.store, and a different home must never return the info result')
  mock.module('../../src/models/roads/typedModelIds.ts', () => ({ ...modelLists, readModelListFacts: () => [{ family: 'openai', name: 'OpenAI', typed: [], list: { kind: 'list', ids: [], fetchedAtMs: 42 } }] }))
  process.env.OPENAI_API_KEY = 'fixture-openai-key'
  const actual = composeActual({ refresh: true }).families.find(family => family.family === 'openai')
  check('the producer carries the catalogue owner timestamp without inventing a read', (actual as { catalogueReadAt?: number } | undefined)?.catalogueReadAt === 42, actual, 'composeSignInView in src/daemon/session-seat/signInView.ts must copy the model list fetchedAtMs from readModelListFacts onto the family row as catalogueReadAt')
  delete process.env.OPENAI_API_KEY
  console.log(`${failures ? 'FAIL' : 'PASS'} daemon sign-in freshness; failures=${failures}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
