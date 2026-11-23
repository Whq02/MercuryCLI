import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { catalogue, installFixture, proofHome, removeProofHome, root, serverPath } from './fixture.ts'

process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_RECESS = '0'
process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const project = join(proofHome, 'project')
mkdirSync(project)
process.chdir(project)
installFixture()
const React = await import('react')
const { App } = await import('../../src/boot/App.js')
const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.js')
const { Chat } = await import('../../src/screen/chat/Chat.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.js')
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.js')
const { readMediaSettings, saveMediaSettings, mediaEnvironment, mediaRoot } = await import('../../src/integrations/media/settings.js')
const { writeHostRecord } = await import('../../src/models/hosting/store.js')
const { mediaHostChoices } = await import('../../src/integrations/media/host.js')
const { mediaRows, mediaRuntimeChoice } = await import('../../src/integrations/media/setup.js')
const { imageSetupPopupRequest } = await import('../../src/commands/imagesetup/imagesetup.js')
const popup = await import('../../src/screen/cockpit/settingsPopup.js')
const route = await import('../../src/screen/routes/surfaceRoute.js')
const { markDaemonHaltStanddown } = await import('../../src/daemon/control/daemonStanddown.js')
const { setFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.js')
markDaemonHaltStanddown()
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, hasCompletedOnboarding: true, theme: 'dark' }))
updateSettingsForSource('userSettings', { media: { root, serverPath } })
const record = { id: 'fixture-rental', name: 'fixture GPU', recipe: 'fixture', price: 1, startedAt: new Date().toISOString(), status: 'RUNNING', jobState: 'ready' as const, target: { host: 'gpu.example' } }
writeHostRecord(record)
writeHostRecord({ ...record, id: 'stopped-rental', status: 'EXITED', jobState: 'stopped' })
assert.deepEqual(mediaHostChoices().map(row => row.id), [record.id])
setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'media-host-picker' }))
route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
let pulls = 0
const machine = { totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 48 * 1024 ** 3 }
const remoteCatalogue = { ...catalogue, runtime: { ...catalogue.runtime, platforms: { 'linux-x64': [{ variant: 'cuda12', binary: 'sd-server', files: [], source: { revision: 'a'.repeat(40), fallback: 'vulkan' } }] } } }
const io = {
  read: async () => { const host = readMediaSettings().host; return { root: mediaRoot(), ...(host ? { host, location: 'Runpod pod fixture-rental' } : {}), catalogue, config: {}, runtimeInstalled: false, runtime: host ? mediaRuntimeChoice(remoteCatalogue, 'linux', 'x64', 'nvidia') : mediaRuntimeChoice(catalogue, 'darwin', 'arm64'), freeBytes: 100e9, ...machine, rows: mediaRows(catalogue, root, machine, 100e9) } },
  places: () => [{ id: '', words: 'Local images and video' }, { id: record.id, words: 'Runpod pod fixture-rental · fixture GPU · running · $1.00/hr' }],
  choose: async (host: string) => { await saveMediaSettings({ host }) },
  pull: async () => { pulls++ },
  setDefault: async () => {},
  test: async () => { throw new Error('No image returned.') },
}
const h = React.createElement
const mounted = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(SurfaceRouter, null, h(Chat, { commands: [], initialTools: [] })) }), 120, 40)
const output = process.argv[process.argv.indexOf('--frames') + 1]
async function frame(name: string, m: Mounted): Promise<void> {
  if (!process.argv.includes('--frames') || !output) return
  mkdirSync(output, { recursive: true })
  const lines = m.lines()
  const grid = lines.map((line, y) => [...line].map((c, x) => ({ c, ...m.styleAt(x, y) })))
  const path = join(output, name + '.json')
  writeFileSync(path, JSON.stringify({ grid, cols: 120, rows: 40 }))
  await gridToPng(path, join(output, name + '.png'))
}
const press = async (key: string) => { mounted.push(key); await settle(200) }
try {
  await settle(300)
  popup.openSettingsPopup(imageSetupPopupRequest(io))
  assert.ok(await waitFor(() => mounted.screen().includes('stable-diffusion.cpp'), 5000), mounted.screen())
  await settle(300)
  await press(KEY.enter)
  assert.ok(mounted.screen().includes('Where should the model run?'), 'media host picker missing prompt heading; check imageSetupPopupRequest')
  assert.ok(mounted.screen().includes('$1.00/hr'), 'media host picker missing rental hourly rate $1.00/hr; check media host picker rows')
  await frame('picker', mounted)
  await press(KEY.down)
  await press(KEY.enter)
  assert.ok(await waitFor(() => mounted.screen().includes('stable-diffusion.cpp (CUDA 12)'), 5000), 'media host picker did not display CUDA 12 runtime within 5000ms; check media host runtime view')
  assert.equal(readMediaSettings().host, record.id)
  assert.ok(mounted.screen().includes('MIT · Runpod pod fixture-rental'), 'media runtime screen missing Runpod pod location label; check media host picker')
  assert.equal(mediaEnvironment().MEDIA_REMOTE_ID, record.id)
  await frame('runtime', mounted)
  await press('p')
  assert.ok(mounted.screen().includes('download → Runpod pod fixture-rental'), 'media pull prompt missing remote destination label; check media pull view')
  assert.ok(!mounted.screen().includes('0 B download'), 'media pull prompt displayed 0 B download instead of real size; check media pull plan')
  await frame('pull', mounted)
  await press(KEY.esc)
  assert.equal(pulls, 0)
  await press(KEY.enter)
  await press(KEY.enter)
  assert.ok(await waitFor(() => readMediaSettings().host === '', 5000), `returning to local did not clear media host setting within 5000ms (host=${readMediaSettings().host}); check saveMediaSettings`)
  assert.deepEqual(mediaEnvironment(), { MEDIA_ROOT: root })
  await saveMediaSettings({ host: record.id })
  assert.equal(readMediaSettings().host, record.id)
  console.log('media host picker: existing host rows, persisted choice, CUDA runtime location, machine pull destination, cancel without setup and return to local')
} finally { popup.closeSettingsPopup(); mounted.unmount(); process.chdir(proofHome); removeProofHome() }
process.exit(0)
