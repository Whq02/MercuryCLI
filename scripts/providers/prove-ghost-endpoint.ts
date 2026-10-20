import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from './lib/llmhostFixture.ts'
import { gridToPng } from '../ui/gridToPng.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
async function saveFrame(view: Mounted, cols: number, name: string): Promise<void> {
  if (!frames) return
  writeFileSync(join(frames, name + '-' + cols + '.txt'), view.screen())
  const grid = view.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = view.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
  const json = join(frames, name + '-' + cols + '.json')
  writeFileSync(json, JSON.stringify({ grid, cols, rows: 40 }))
  await gridToPng(json, join(frames, name + '-' + cols + '.png'))
}
const f = await llmhostFixture()
f.state.auth = true
const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') })
const port = closed.port!
closed.stop(true)
let failures = 0
const check = (name: string, ok: unknown) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++ }
const realFetch = globalThis.fetch
let attempts = 0
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('http://127.0.0.1:' + port)) attempts++
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  throw new Error('The proof allows only loopback requests')
}) as typeof fetch
try {
  const React = await import('react')
  const { Text } = await import('../../src/ink.ts')
  const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
  const { createStore } = await import('../../src/state/store.ts')
  const { call } = await import('../../src/commands/model/mercuryModel.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { configuredCompatEndpoints, isCompatEndpointCredentialed } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { cachedCompatCatalogue, namedCompatModelOptions, refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const { writeStoredCompatApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { writeHostRecord, readHostRecord } = await import('../../src/services/host/store.ts')
  const { runpodFixture } = await import('../host/runpodFixture.mjs')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const configured = updateSettingsForSource('userSettings', { compatProvider: {
    ghost: { baseUrl: 'http://127.0.0.1:' + port + '/v1', label: 'Ghost GLM' },
    locked: { baseUrl: f.baseUrl, label: 'Locked GLM', keyCommand: 'printf ""' },
  } })
  assert.ifError(configured.error)
  await refreshCompatCatalogues({ force: true })
  for (const cols of [120, 80]) {
    const dispatched: Array<{ words: string; options?: any }> = []
    const store = createStore({ ...getDefaultAppState(), engineModel: 'compat/ghost/absent' }, () => {})
    const element = await call((words: string, options?: any) => { dispatched.push({ words, options }) }, { messages: [] } as never, '')
    const m = await mountOffscreen(React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(ThemeProvider, {}, element)), cols, 40)
    const capture = (name: string, view = m) => saveFrame(view, cols, name)
    try {
      assert.ok(await waitFor(() => m.screen().includes('Mercury'), 5000), m.screen())
      assert.ok(await waitFor(() => m.screen().includes('│ │ Ghost GLM'), 5000), m.screen())
      await capture('ghost')
      const row = namedCompatModelOptions().find(row => row.value === '__mercury_connect__:compat/ghost')!
      const endpoint = configuredCompatEndpoints().find(endpoint => endpoint.name === 'ghost')!
      const error = cachedCompatCatalogue(endpoint)?.error
      check(cols + ': key-less closed port names host, last error and retry/check doors', Boolean(row?.label.includes('server at 127.0.0.1:' + port + ' not answering') && error && row.label.includes(error) && row.label.includes('↵ retries · /llmhost checks it')))
      check(cols + ': key-less row is credentialed by the shared rule', isCompatEndpointCredentialed(endpoint))
      const before = attempts
      m.push(KEY.enter)
      await waitFor(() => attempts > before || dispatched.length > 0, 5000)
      check(cols + ': Enter retries the catalogue rather than /logins', attempts > before && dispatched.length === 0)
      await capture('ghost-retry')
      let previous: string | undefined
      let moves = 0
      assert.ok(await waitFor(() => {
        const selected = m.lines().find(line => line.includes('│ │ ')) ?? ''
        if (selected.includes('Locked GLM')) return true
        if (selected !== previous && moves < 8) { previous = selected; moves++; m.push(KEY.down) }
        return false
      }, 6000), m.screen())
      await capture('needs-key')
      m.push(KEY.enter)
      await waitFor(() => dispatched.some(row => row.options?.nextInput?.includes('compat/locked')), 5000)
      const signIn = dispatched.find(row => row.options?.nextInput?.includes('compat/locked'))
      check(cols + ': missing key opens its own endpoint and returns to /model', signIn?.options?.nextInput === '/logins compat/locked --return=/model' && signIn.words.startsWith("Custom endpoint 'locked' — running /logins compat/locked"))
      if (signIn) {
        const notice = await mountOffscreen(React.createElement(Text, null, signIn.words), cols, 40)
        await waitFor(() => notice.screen().includes('running /logins'), 2000)
        await capture('sign-in-line', notice)
        notice.unmount()
      }
      check(cols + ': endpoint sign-in never names DeepSeek', Boolean(signIn) && !signIn!.words.includes('DeepSeek'))
    } finally { m.unmount() }
  }
  writeStoredCompatApiKey(f.key, 'locked')
  await refreshCompatCatalogues({ force: true, name: 'locked' })
  check('return from key entry restores the model row', namedCompatModelOptions().some(row => row.value === 'compat/locked/' + f.model && !row.unavailable))
  const rp = await runpodFixture()
  writeStoredRunpodApiKey(rp.key)
  try {
    const { Box } = await import('../../src/ink.ts')
    const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
    const { openSettingsPopup, closeSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
    const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
    const { getSettingsForSource } = await import('../../src/utils/settings/settings.ts')
    for (const cols of [120, 80]) {
      const podId = 'fixture-owned-' + cols
      const pod = { ...JSON.parse(readFileSync(new URL('../host/fixtures/pod-get-running.json', import.meta.url), 'utf8')), id: podId, name: 'Fixture GLM', cost: 2, status: 'RUNNING', startedAt: new Date(Date.now() - 3600_000).toISOString() }
      rp.state.pods.set(podId, pod)
      assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { managed: { baseUrl: f.baseUrl, models: [f.model] }, manual: { baseUrl: f.baseUrl, models: [f.model] } }, models: { ['compat/managed/' + f.model]: { contextWindow: 131072 }, ['compat/manual/' + f.model]: { contextWindow: 131072 } } }).error)
      writeHostRecord({ id: podId, name: pod.name, recipe: 'fixture', price: 2, startedAt: pod.startedAt, status: 'RUNNING', provider: 'managed' })
      const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'fixture-session' })
      openSettingsPopup(llmHostPopupRequest(road))
      const store = createStore(getDefaultAppState(), () => {})
      const m = await mountOffscreen(React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(ThemeProvider, {}, React.createElement(Box, { width: cols, height: 40 }, React.createElement(SettingsPopupSlot)))), cols, 40)
      const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 6000), m.screen())
      const choose = async (text: string) => {
        let previous: string | undefined
        let moves = 0
        assert.ok(await waitFor(() => {
          const selected = m.lines().find(line => line.includes('› ')) ?? ''
          if (selected.includes(text)) return true
          if (selected !== previous && moves < 25) { previous = selected; moves++; m.push(KEY.down) }
          return false
        }, 6000), 'selection reaches ' + text + '\n' + m.screen())
        m.push(KEY.enter)
      }
      try {
        await until('Which model?'); await choose('Pods I’m paying for'); await until(podId); await choose(podId); await until('Pod controls'); await choose('Terminate'); await until('Confirm terminate')
        await saveFrame(m, cols, 'terminate-confirm')
        await choose('Confirm terminate'); await until('Pod terminated'); await saveFrame(m, cols, 'terminated')
        const settings = getSettingsForSource('userSettings')!
        check(cols + ': Terminate deletes the recorded provider and only its model capabilities', !configuredCompatEndpoints().some(row => row.name === 'managed') && !settings.models?.['compat/managed/' + f.model] && Boolean(settings.models?.['compat/manual/' + f.model]))
        check(cols + ': a hand registration with no pod record stays', configuredCompatEndpoints().some(row => row.name === 'manual'))
        check(cols + ': termination is read back before the pod record is removed', !readHostRecord(podId) && !rp.state.pods.has(podId))
      } finally { closeSettingsPopup(); m.unmount() }
    }
    assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { orphan: { baseUrl: f.baseUrl, hostPodId: 'vanished-pod', label: 'Orphan GLM', models: [f.model] } } }).error)
    check('a known pod registration whose record is gone names termination instead of sign-in', namedCompatModelOptions().some(row => row.value === '__mercury_connect__:compat/orphan' && row.label === 'Orphan GLM · pod terminated — /llmhost rents again'))
    f.state.auth = false
    assert.ifError(updateSettingsForSource('userSettings', { compatProvider: { free: { baseUrl: f.baseUrl, label: 'Local GLM' } } }).error)
    await refreshCompatCatalogues({ force: true, name: 'free' })
    for (const cols of [120, 80]) {
      const { MercuryModelChoicePicker } = await import('../../src/commands/model/mercuryModel.tsx')
      const orphan = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(MercuryModelChoicePicker, { current: '__mercury_connect__:compat/orphan', onSelect() {}, onSignIn() {}, onClose() {} })), cols, 40)
      try { assert.ok(await waitFor(() => orphan.screen().includes('pod terminated'), 5000), orphan.screen()); await saveFrame(orphan, cols, 'orphan') } finally { orphan.unmount() }
      const returned = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(MercuryModelChoicePicker, { current: 'compat/locked/' + f.model, onSelect() {}, onSignIn() {}, onClose() {} })), cols, 40)
      try { assert.ok(await waitFor(() => returned.screen().includes('compat/locked'), 5000), returned.screen()); await saveFrame(returned, cols, 'returned-after-key') } finally { returned.unmount() }
      const free = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(MercuryModelChoicePicker, { current: 'compat/free/' + f.model, onSelect() {}, onSignIn() {}, onClose() {} })), cols, 40)
      try {
        assert.ok(await waitFor(() => free.screen().includes('no key (local/auth-free endpoint)'), 5000), free.screen())
        check(cols + ': a live key-less endpoint shows its no-key badge and named group', free.screen().includes('LOCAL GLM (FREE)'))
        await saveFrame(free, cols, 'no-key-badge')
      } finally { free.unmount() }
    }
  } finally { await rp.close() }
  {
    const picker = readFileSync(new URL('../../src/commands/model/mercuryModel.tsx', import.meta.url), 'utf8')
    const options = readFileSync(new URL('../../src/utils/model/modelOptions.ts', import.meta.url), 'utf8')
    const lanes = [...(/export function parseKeyConnectValue\([\s\S]*?\): ([^{]+)\{/.exec(options)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map(match => match[1]!).filter(lane => lane !== 'compat' && lane !== 'moonshot')
    const labels = /const keyLaneLabels[^=]*= \{([^}]*)\}/.exec(picker)?.[1] ?? ''
    const labelled = [...labels.matchAll(/\b([a-z]+): '/g)].map(match => match[1]!)
    check('every key lane the picker can route to /logins names itself in its sign-in line; none falls through to another family', lanes.length >= 13 && lanes.every(lane => labelled.includes(lane)) && labels.includes("zen: 'OpenCode Zen'") && !/: 'DeepSeek'\} sign-in/.test(picker))
  }
  console.log('GHOST ENDPOINT ' + (failures ? 'RED' : 'GREEN') + ' — ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { globalThis.fetch = realFetch; f.close() }
