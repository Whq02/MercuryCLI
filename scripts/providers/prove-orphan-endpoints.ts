import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from './lib/llmhostFixture.ts'
import { runpodFixture } from '../host/runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { HostRecord } from '../../src/services/host/store.ts'
import type { LlmHostEvent, LlmHostRoad } from '../../src/services/llmHost/index.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
async function capture(view: Mounted, cols: number, name: string): Promise<void> {
  if (!frames) return
  writeFileSync(join(frames, name + '-' + cols + '.txt'), view.screen())
  const grid = view.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = view.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
  const json = join(frames, name + '-' + cols + '.json')
  writeFileSync(json, JSON.stringify({ grid, cols, rows: 40 }))
  await gridToPng(json, join(frames, name + '-' + cols + '.png'))
}
let failures = 0
let checks = 0
const check = (name: string, ok: unknown) => { checks++; console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++ }
const f = await llmhostFixture()
const rp = await runpodFixture()
const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') })
const closedBase = 'http://127.0.0.1:' + closed.port + '/v1'
closed.stop(true)
const realFetch = globalThis.fetch
let attempts = 0
let refusePods = false
let external = 0
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { external++; return Promise.reject(new Error('Proof refused off-loopback request')) }
  if (url.href.startsWith(closedBase)) attempts++
  if (refusePods && url.pathname === '/v2/pods') return Promise.resolve(Response.json({ error: 'fixture account list unavailable' }, { status: 401 }))
  return realFetch(input, init)
}) as typeof fetch
let stopJob: (() => Promise<void>) | undefined
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
  const { createStore } = await import('../../src/state/store.ts')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { call } = await import('../../src/commands/model/mercuryModel.tsx')
  const { getSettingsForSource, updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const { readStoredCompatApiKey, writeStoredCompatApiKey, writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostDirectory, readHostRecord, writeHostRecord } = await import('../../src/services/host/store.ts')
  const { hostJobRunning } = await import('../../src/services/host/jobs.ts')
  const { startService, stopService } = await import('../../src/services/projectServices/serviceManager.ts')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const { openSettingsPopup, closeSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const mount = async (element: React.ReactNode, cols: number, model?: string) => {
    const store = createStore({ ...getDefaultAppState(), ...(model ? { engineModel: model } : {}) }, () => {})
    return mountOffscreen(React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(ThemeProvider, {}, element)), cols, 40)
  }
  const registered = (name: string) => configuredCompatEndpoints().some(row => row.name === name)
  for (const cols of [120, 80]) {
    assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { llmhost: { baseUrl: closedBase, label: 'Hand GLM' } } }).error)
    writeStoredCompatApiKey(f.key, 'llmhost')
    await refreshCompatCatalogues({ force: true, name: 'llmhost' })
    let dispatched = 0
    const element = await call(() => { dispatched++ }, { messages: [] } as never, '')
    const m = await mount(element, cols, 'compat/llmhost/absent')
    try {
      assert.ok(await waitFor(() => m.screen().includes('Hand GLM'), 5000), m.screen())
      await capture(m, cols, 'model-actions')
      const hasRemove = m.screen().includes('Remove this endpoint →')
      check(cols + ': unreachable hand registration offers both Retry and Remove', m.screen().includes('Retry this server →') && hasRemove)
      const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'compat/llmhost')
      check(cols + ': logins names the remove-in-model road for the unreachable endpoint', row?.label.includes('remove in /model'))
      const before = attempts
      m.push(KEY.enter)
      check(cols + ': Retry reads the endpoint again without closing the picker', await waitFor(() => attempts > before && m.screen().includes('still registered'), 5000) && dispatched === 0)
      if (hasRemove) {
        m.push(KEY.down)
        assert.ok(await waitFor(() => m.lines().some(line => line.includes('› ') && line.includes('Remove this endpoint')) || m.screen().includes('│ │ Hand GLM · Remove this endpoint'), 5000), m.screen())
        m.push(KEY.enter)
        check(cols + ': removal confirms in the open picker', await waitFor(() => m.screen().includes('Removed custom endpoint llmhost · nothing else changed'), 5000))
      }
      check(cols + ': removal deletes settings and the stored key', !registered('llmhost') && !readStoredCompatApiKey('llmhost'))
      check(cols + ': endpoint row disappears on the next paint without closing', !m.screen().includes('Hand GLM') && m.screen().includes('Mercury') && dispatched === 0)
      await capture(m, cols, 'model-removed')
    } finally { m.unmount() }
  }
  assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { live: { baseUrl: f.baseUrl, label: 'Live GLM' } } }).error)
  for (const listed of [true, false]) {
    f.state.listed = listed
    await refreshCompatCatalogues({ force: true, name: 'live' })
    const element = await call(() => {}, { messages: [] } as never, 'live')
    const m = await mount(element, 80, 'compat/live/' + f.model)
    try {
      assert.ok(await waitFor(() => m.screen().includes('LIVE GLM'), 5000), m.screen())
      check('answering endpoint ' + (listed ? 'with models' : 'with an empty model list') + ' never offers Remove', !m.screen().includes('Remove this endpoint'))
      await capture(m, 80, listed ? 'live-model' : 'live-empty')
    } finally { m.unmount() }
  }
  f.state.listed = true
  const stamp = new Date().toISOString()
  const record = (id: string, patch: Partial<HostRecord> = {}): HostRecord => ({ id, name: id, recipe: 'fixture', price: 1, status: 'RUNNING', startedAt: stamp, ...patch })
  const ended = record('gone-pod', { provider: 'pod-gone' })
  const protectedRecords = [record('watch-pod', { jobKind: 'watch' }), record('creating-pod', { creating: 'pending-create' }), record('queued-pod', { jobState: 'queued' }), record('starting-pod', { jobState: 'starting' }), record('running-pod', { jobKind: 'setup', jobState: 'running' })].map(row => ({ ...row, provider: 'endpoint-' + row.id }))
  for (const row of [ended, ...protectedRecords]) writeHostRecord(row)
  const livePod = { ...JSON.parse(readFileSync(new URL('../host/fixtures/pod-get-running.json', import.meta.url), 'utf8')), id: 'live-pod', name: 'Live pod', startedAt: stamp }
  rp.state.pods.set(livePod.id, livePod)
  assert.ifError(updateSettingsForSource('userSettings', { compatProvider: Object.fromEntries([
    ['manual', { baseUrl: closedBase, label: 'Manual survivor' }],
    ['pod-gone', { baseUrl: closedBase, hostPodId: ended.id }],
    ['pod-record-gone', { baseUrl: closedBase, hostPodId: 'missing-record-pod' }],
    ['pod-live', { baseUrl: f.baseUrl, hostPodId: livePod.id }],
    ...protectedRecords.map(row => [row.provider, { baseUrl: closedBase, hostPodId: row.id }]),
  ]) }).error)
  for (const name of ['pod-gone', 'pod-record-gone', 'manual']) writeStoredCompatApiKey(f.key, name)
  const started = await startService({ sessionId: 'orphan-endpoints-proof', spec: { name: 'host-running-pod', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 120000)'], cwd: hostDirectory(), readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' } })
  assert.ok('record' in started, JSON.stringify(started))
  stopJob = async () => { const stopped = await stopService(hostDirectory(), 'host-running-pod'); assert.ok('record' in stopped, JSON.stringify(stopped)) }
  assert.ok(hostJobRunning(protectedRecords.at(-1)!))
  writeStoredRunpodApiKey(rp.key)
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'orphan-endpoints-proof' })
  const events: LlmHostEvent[] = []
  const visited: string[] = []
  const observed: LlmHostRoad = (ask, emit, signal) => road(q => { visited.push(q.step); return ask(q) }, event => { events.push(event); emit(event) }, signal)
  const beforeReads = rp.requests.filter((r: any) => r.method === 'GET' && r.path === '/v2/pods').length
  openSettingsPopup(llmHostPopupRequest(observed))
  const host = await mount(React.createElement(Box, { width: 120, height: 40 }, React.createElement(SettingsPopupSlot)), 120)
  try {
    assert.ok(await waitFor(() => host.screen().includes('Which model?'), 10000), host.screen())
    check('one model-first door open removes the ended pod record and endpoint', !readHostRecord(ended.id) && !registered('pod-gone'))
    check('the same sweep removes a pod-linked endpoint whose record is already gone', !registered('pod-record-gone'))
    check('the sweep removes both stored endpoint keys', !readStoredCompatApiKey('pod-gone') && !readStoredCompatApiKey('pod-record-gone'))
    for (const name of ['pod-gone', 'pod-record-gone']) {
      const line = name + ' is no longer in the account — its model entry was removed'
      check(name + ': sweep emits one log line and paints it on the door', events.filter(event => event.words === line).length === 1 && host.screen().includes(line))
    }
    check('the sweep uses one account pod list and never enters Other roads', rp.requests.filter((r: any) => r.method === 'GET' && r.path === '/v2/pods').length === beforeReads + 1 && visited.join(',') === 'door-models')
    check('watches, creates, queued and starting jobs, and an actually running job survive with their endpoints', protectedRecords.every(row => Boolean(readHostRecord(row.id)) && registered(row.provider!)) && hostJobRunning(protectedRecords.at(-1)!))
    check('a live account pod is preserved even if its host record is absent', registered('pod-live'))
    check('a hand registration sharing the closed loopback port survives the pod sweep', registered('manual') && readStoredCompatApiKey('manual') === f.key)
    check('unrelated settings remain intact', Boolean(getSettingsForSource('userSettings')?.compatProvider) && registered('live'))
    await capture(host, 120, 'host-swept')
  } finally { closeSettingsPopup(); host.unmount() }
  refusePods = true
  const unavailable = record('unread-pod', { provider: 'unread' })
  writeHostRecord(unavailable)
  assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { unread: { baseUrl: closedBase, hostPodId: unavailable.id } } }).error)
  await road(async () => null, () => {}, new AbortController().signal)
  check('an unread account list never sweeps records or endpoints', Boolean(readHostRecord(unavailable.id)) && registered('unread'))
  check('no billable operations or external requests', rp.state.creates === 0 && rp.state.deletes === 0 && external === 0)
  console.log('ORPHAN ENDPOINTS ' + (failures ? 'RED' : 'GREEN') + ' — ' + checks + ' checks; ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally {
  try { await stopJob?.() } finally { globalThis.fetch = realFetch; await rp.close(); f.close() }
}
