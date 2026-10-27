#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { proofHome } from '../lib/hermetic.ts'

delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
for (const key of ['MEDIA_ROOT', 'MEDIA_CATALOG', 'MEDIA_IMAGE_MODEL', 'MEDIA_VIDEO_MODEL', 'MEDIA_OUTPUT_DIR']) delete process.env[key]
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_HOME = join(proofHome, 'proof-home')
process.env.MERCURY_DAEMON_DIR = join(proofHome, 'daemon')
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.FORCE_COLOR = '3'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_CLIPBOARD_FILE = join(proofHome, 'clipboard.txt')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const PROJECT = join(proofHome, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME, { recursive: true })
process.chdir(PROJECT)

const COLS = 120
const ROWS = 40
const SESSION = 'imagesetup-esc'
const PLACEHOLDER = 'Type a prompt'
const TITLE = 'Mercury · imagesetup'
const arg = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function keepFrame(name: string, m: Mounted): void {
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), m.lines().join('\n') + '\n')
}

const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const route = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const helm = await import('../../src/utils/cockpit/helmFocus.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const overlays = await import('../../src/context/overlayStack.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
const { readMediaCatalogue } = await import('../../src/services/media/catalogue.js')
const { mediaRuntimeChoice, mediaRuntimeRowWords } = await import('../../src/services/media/setup.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)
slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => SESSION }))
route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})

const h = React.createElement
const composerRow = (m: Mounted): string => { const rows = m.lines().filter(line => /^│?❯/.test(line)); return rows[rows.length - 1] ?? '(no composer row)' }
const selectedRow = (m: Mounted): string => m.lines().find(line => line.includes('› '))?.trim() ?? '(no selection)'
async function press(m: Mounted, data: string, ms = 160): Promise<void> { m.push(data); await settle(ms) }
const click = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`

const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))), COLS, ROWS, { mouseTracking: true })
try {
  await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
  await settle(300)
  check('the chat painted its empty composer', composerRow(m).includes(PLACEHOLDER), composerRow(m))

  const catalogue = await readMediaCatalogue({ enabled: false })
  const expectedRow = mediaRuntimeRowWords({ runtime: mediaRuntimeChoice(catalogue), runtimeInstalled: false })
  const open = async (label: string): Promise<void> => {
    helm.requestCommandDispatch('/imagesetup')
    const opened = await waitFor(() => popup.isSettingsPopupOpen() && m.screen().includes(TITLE) && m.screen().includes('stable-diffusion.cpp'), 8000)
    await settle(400)
    check(`${label}: /imagesetup opened over the chat`, opened, m.lines().filter(line => line.includes('Mercury') || line.includes('stable-diffusion')).join(' | '))
  }

  await open('§1')
  keepFrame('01-open', m)
  check('§1 the runtime row names the build this computer pulls', m.screen().includes(expectedRow), `${expectedRow} · ${selectedRow(m)}`)
  check('§1 the popup frame is a modal elevated surface, so a click outside reaches it as esc', overlays.anyModalOverlayActive() && overlays.overlayStackSnapshot().some(entry => entry.id === 'elevated-surface'), JSON.stringify(overlays.overlayStackSnapshot()))
  await press(m, KEY.down, 250)
  check('§1 ↓ moves the selection to the first model', selectedRow(m).includes(catalogue.models[0]!.id), selectedRow(m))
  await press(m, KEY.esc, 250)
  const closedByEsc = await waitFor(() => !popup.isSettingsPopupOpen(), 1500)
  await settle(300)
  keepFrame('02-after-esc', m)
  check('§1 esc closes /imagesetup', closedByEsc && !m.screen().includes(TITLE), selectedRow(m))
  await press(m, 'h', 120)
  await press(m, 'i', 120)
  const typed = await waitFor(() => pending.text() === 'hi', 3000)
  check('§1 the composer is reachable after esc: typed text lands in it', typed && composerRow(m).includes('hi'), `composer ${JSON.stringify(pending.text())} · ${composerRow(m)}`)
  pending.edit('')
  await settle(150)

  await open('§2')
  await press(m, click(0, 0), 250)
  const closedByClick = await waitFor(() => !popup.isSettingsPopupOpen(), 1500)
  await settle(300)
  keepFrame('03-after-click-outside', m)
  check('§2 a click outside closes /imagesetup', closedByClick && !m.screen().includes(TITLE))
  check('§2 the click touched nothing beneath: the composer is still empty', pending.text() === '', JSON.stringify(pending.text()))

  await open('§3')
  await press(m, '\x03', 300)
  check('§3 one ctrl+c leaves /imagesetup open, as every settings popup does', popup.isSettingsPopupOpen() && m.screen().includes(TITLE))
  await press(m, KEY.esc, 250)
  check('§3 esc still closes after the ctrl+c', await waitFor(() => !popup.isSettingsPopupOpen(), 1500))
  await settle(300)

  await open('§4')
  await press(m, 'p', 300)
  check('§4 p on the runtime row opens the download card', m.screen().includes('y download · n back') && m.screen().includes('github.com/leejet/stable-diffusion.cpp'), m.lines().filter(line => line.includes('download')).join(' | '))
  await press(m, KEY.esc, 300)
  check('§4 esc on the card goes back to the table without downloading', popup.isSettingsPopupOpen() && !m.screen().includes('y download') && m.screen().includes(expectedRow), m.lines().filter(line => line.includes('stable-diffusion')).join(' | '))
  await press(m, KEY.esc, 250)
  check('§4 the next esc closes the table', await waitFor(() => !popup.isSettingsPopupOpen(), 1500))
  await settle(300)

  helm.requestCommandDispatch('/config')
  check('§5 /config opened for the same ctrl+c rule', await waitFor(() => popup.isSettingsPopupOpen() && popup.settingsPopupRequest()?.view === 'config', 8000))
  await settle(300)
  await press(m, '\x03', 300)
  check('§5 one ctrl+c leaves /config open too', popup.isSettingsPopupOpen())
  await press(m, KEY.esc, 250)
  check('§5 esc closes /config', await waitFor(() => !popup.isSettingsPopupOpen(), 1500))
} finally {
  m.unmount()
}
console.log(`imagesetup esc: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
