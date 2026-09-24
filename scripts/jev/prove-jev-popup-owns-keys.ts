#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
const HOME = pinScratchHome('jev-popup-keys')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 178
const ROWS = 51
const BACKSPACE = '\x7f'
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const React = await import('react')
const { Text } = await import('../../src/ink.js')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.js')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.js')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.js')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.js')
const { CancelRequestHandler } = await import('../../src/hooks/useCancelRequest.js')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.js')
const helm = await import('../../src/utils/cockpit/helmFocus.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const cap = await import('../../src/services/switchboard/capacityCheck.js')
cap._setHeldMachineSeatReadingForTesting(6, { cores: 8, availableBytes: 6 * cap.SEAT_COST_BYTES.runner, read: 'vm_stat', sampledAt: 0 })
const setting = await import('../../src/services/jev/jevSetting.js')
const keyOwner = await import('../../src/services/jev/jevKey.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { call: jevCall } = await import('../../src/commands/jev/jev.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const jevBody = await import('../../src/components/Settings/Jev.js')
const { BootSettingsScreen } = await import('../../src/components/BootSettingsScreen.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')

const h = React.createElement
const configFile = join(HOME, '.mercury.json')
const storedJev = (): Record<string, unknown> | undefined => {
  if (!existsSync(configFile)) return undefined
  return (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>).jev as Record<string, unknown> | undefined
}
const frames: Array<{ name: string; note: string; lines: string[] }> = []
function keepFrame(name: string, note: string, m: Mounted): string[] {
  const lines = m.lines()
  frames.push({ name, note, lines })
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), lines.join('\n') + '\n')
  return lines
}
const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
const jevRowMark = `${jevBody.JEV_ROW_MARK} `
function popupCell(lines: string[], mark: string): string {
  const line = lines.find(candidate => candidate.includes(mark))
  if (line === undefined) return ''
  const at = line.indexOf(mark)
  const end = line.indexOf('│', at)
  return line.slice(at, end < 0 ? undefined : end).trim()
}
const rowLine = (m: Mounted, label: string): string => popupCell(m.lines(), `${jevRowMark}${label}`)
const bootJevRow = (lines: string[]): string => lines.find(line => /❯ JEV\s+(?:on|off)\s/.test(line)) ?? ''
async function press(m: Mounted, data: string, ms = 160): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function selectMarked(m: Mounted, mark: string, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (has(m.lines(), mark)) return true
    await press(m, KEY.down, 70)
  }
  return has(m.lines(), mark)
}

let interrupts = 0
slot.setFocusedSessionConnector(
  Object.assign(new NoSessionConnector(), {
    sessionId: () => 'proof-session',
    interrupt: (): boolean => {
      interrupts++
      return true
    },
  }),
)

const sent: string[] = []
initializeSurfaceRoute(ROOT_REPL_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
const scrollRef = React.createRef<import('../../src/ink/components/ScrollBox.js').ScrollBoxHandle>()
const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.js').PromptInputProps['insertTextRef']['current']>
function Transcript(): React.ReactNode {
  return h(Text, null, Array.from({ length: 6 }, (_, i) => `transcript row ${i}`).join('\n'))
}
function Cockpit(): React.ReactNode {
  const { controls, focus } = useCompactWorkControls()
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const [screen, setScreen] = React.useState('prompt')
  return h(
    KeybindingSetup,
    null,
    h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
    h(CancelRequestHandler, { screen, focusedTurnActive: true, compactWork: controls } as never),
    h(FullscreenLayout, {
      scrollRef,
      scrollable: h(Transcript),
      statusBand: h(Text, null, 'activity specimen'),
      statusBandActive: false,
      modal: undefined,
      bottom: h(PromptInput, {
        compactWork: controls,
        compactFocus: focus,
        debug: false,
        ideSelection: undefined,
        toolPermissionContext: getDefaultAppState().toolPermissionContext,
        setToolPermissionContext: () => {},
        apiKeyStatus: 'valid',
        commands: [],
        agents: [],
        isLoading: false,
        verbose: false,
        submitCount: sent.length,
        onShowMessageSelector: () => {},
        mcpClients: [],
        vimMode,
        setVimMode,
        showBashesDialog: bashes,
        setShowBashesDialog: setBashes,
        onExit: () => {},
        getToolUseContext: () => ({}) as never,
        onSubmit: async (value: string) => {
          sent.push(value)
          pending.clearForSubmit(value)
        },
        isSearchingHistory: searching,
        setIsSearchingHistory: setSearching,
        helpOpen: help,
        setHelpOpen: setHelp,
        hasSuppressedDialogs: false,
        isLocalJSXCommandActive: false,
        insertTextRef: insertRef,
      } as never),
    } as never),
  )
}

section('§0 the cockpit chrome at 178x51: the real composer, the popup slot and the lanes rail in one tree')
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(ThemeProvider as never, {}, h(Cockpit))), COLS, ROWS)
await waitFor(() => insertRef.current !== null && m.screen().includes('❯'), 6000)
await settle(300)
check('the composer mounted and painted its prompt row', insertRef.current !== null && m.lines().some(line => line.includes('❯')), m.lines().filter(line => line.trim() !== '').slice(-6).join(' | '))
check('the lanes rail published rows to walk', helm.getHelmRows('lanes').length >= 2, String(helm.getHelmRows('lanes').length))
check('a fresh home: the JEV switch is off, no key, no popup open, nothing sent', setting.jevEnabled() === false && keyOwner.jevKeyPresence().present === false && !store.isSettingsPopupOpen() && sent.length === 0)
keepFrame('cockpit-before-jev-178x51', 'the cockpit chrome at 178x51 before /jev opens: the composer empty, the lanes rail beside it', m)

section('§1 /jev open, the Switch row selected, an empty prompt: ← flips the switch and the manager surface does not open')
await jevCall('', {} as never)
await waitFor(() => m.screen().includes('Mercury · jev'), 4000)
await settle(250)
check('the popup is open on the Switch row', store.isSettingsPopupOpen() && rowLine(m, 'Switch').endsWith('off'), rowLine(m, 'Switch'))
keepFrame('jev-switch-before-left-178x51', '/jev open over the cockpit, the Switch row selected and off, the prompt empty', m)
await press(m, KEY.left, 300)
check('← flipped the one switch on through the owner', setting.jevEnabled() === true && storedJev()?.enabled === true, JSON.stringify(storedJev()))
check('← did not open the manager surface: nothing was submitted from the composer', sent.length === 0, JSON.stringify(sent))
check('the popup is still open and paints the switch on', store.isSettingsPopupOpen() && rowLine(m, 'Switch').endsWith('on'), rowLine(m, 'Switch'))
check("the composer's prompt is unchanged (empty) and helm focus stayed on the prompt", pending.text() === '' && helm.getHelmFocus() === 'prompt')
keepFrame('jev-switch-after-left-178x51', 'the same frame after ←: the Switch row reads on, the receipt names the roster, the composer beneath is untouched', m)
await press(m, KEY.right, 300)
check('→ flipped it back off; still nothing submitted', setting.jevEnabled() === false && sent.length === 0, JSON.stringify(storedJev()))
keepFrame('jev-switch-after-right-178x51', 'after →: the Switch row reads off again', m)

section('§2 ↑/↓ with the lanes rail focused: the popup moves its own selection, the rail cursor and focus do not move')
helm.setHelmFocus('lanes')
helm.setHelmCursor('lanes', 0)
await settle(120)
const cursorBefore = helm.getHelmCursor('lanes')
await press(m, KEY.down, 250)
check('↓ moved the popup selection to the Key row', rowLine(m, 'Key') !== '', m.lines().filter(line => line.includes(jevRowMark)).join(' | '))
check('the rail cursor did not move and the rail keeps focus', helm.getHelmCursor('lanes') === cursorBefore && helm.getHelmFocus() === 'lanes', `${helm.getHelmCursor('lanes')} / ${helm.getHelmFocus()}`)
await press(m, KEY.up, 250)
check('↑ moved the popup selection back to the Switch row; the rail cursor still did not move', rowLine(m, 'Switch') !== '' && helm.getHelmCursor('lanes') === cursorBefore && helm.getHelmFocus() === 'lanes')
check('nothing was submitted and no row was activated through the rail', sent.length === 0)
helm.setHelmFocus('prompt')
await settle(120)

section('§3 ↵ and ⌫ with a draft in the composer: the popup acts, the draft is neither submitted nor edited')
pending.edit('draft')
await waitFor(() => m.screen().includes('draft'), 3000)
await settle(150)
check('the draft is painted in the composer beneath the popup', pending.text() === 'draft')
await press(m, KEY.enter, 300)
check('↵ on the Switch row flipped the switch on', setting.jevEnabled() === true, JSON.stringify(storedJev()))
check('↵ submitted nothing and the draft is intact', sent.length === 0 && pending.text() === 'draft', `${JSON.stringify(sent)} · ${pending.text()}`)
await press(m, BACKSPACE, 300)
check('⌫ on the Switch row returned it to its default (off) with the receipt', setting.jevEnabled() === false && has(m.lines(), 'JEV off — JevEval leaves the roster'), m.lines().filter(line => line.includes('JEV off')).join(' | '))
check('⌫ did not edit the draft', pending.text() === 'draft', pending.text())
keepFrame('jev-after-enter-backspace-178x51', 'after ↵ then ⌫ on the Switch row with a draft in the composer: the receipt paints in the popup, the draft reads draft', m)

section('§4 esc closes the popup through its own road: no interrupt, no cancel-ladder step, the draft and the focus untouched')
await press(m, KEY.esc, 300)
check('esc closed the popup', !store.isSettingsPopupOpen() && !m.screen().includes('Mercury · jev'))
check('esc reached no interrupt: the focused chat was not interrupted', interrupts === 0, String(interrupts))
check('the draft and helm focus are as they were', pending.text() === 'draft' && helm.getHelmFocus() === 'prompt' && sent.length === 0)
pending.edit('')
await settle(120)

section("§5 /config on its JEV row: ←/→ flip it, the rail beneath does not move, esc's revert-then-close is the popup's own")
store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
await waitFor(() => m.screen().includes('Mercury · config'), 4000)
await settle(250)
helm.setHelmFocus('lanes')
helm.setHelmCursor('lanes', 0)
await settle(120)
const configCursorBefore = helm.getHelmCursor('lanes')
const found = await selectMarked(m, `${CONFIG_ROW_MARK} JEV`)
check('↓ walks the /config list to the JEV row', found, m.lines().filter(line => line.includes('JEV')).join(' | '))
check('the walk left the rail cursor and focus alone', helm.getHelmCursor('lanes') === configCursorBefore && helm.getHelmFocus() === 'lanes', `${helm.getHelmCursor('lanes')} / ${helm.getHelmFocus()}`)
keepFrame('config-jev-row-178x51', '/config over the cockpit with the JEV row selected (off)', m)
await press(m, KEY.right, 300)
const configRowOn = popupCell(m.lines(), `${CONFIG_ROW_MARK} JEV`)
check('→ flipped JEV on through the owner and the row reads on', setting.jevEnabled() === true && storedJev()?.enabled === true && /JEV\s+on\b/.test(configRowOn), configRowOn)
keepFrame('config-jev-after-right-178x51', 'after →: the JEV row reads on and its warning is the settings line', m)
await press(m, KEY.left, 300)
check('← flipped it off again; nothing submitted, the rail still where it was', setting.jevEnabled() === false && sent.length === 0 && helm.getHelmCursor('lanes') === configCursorBefore)
await press(m, KEY.right, 300)
await press(m, KEY.esc, 300)
check('the first esc reverts the touched key to its mount-time value (off) and the popup stays', store.isSettingsPopupOpen() && setting.jevEnabled() === false, JSON.stringify(storedJev()))
await press(m, KEY.esc, 300)
check('the second esc closes /config; no interrupt fired', !store.isSettingsPopupOpen() && interrupts === 0)
helm.setHelmFocus('prompt')
await settle(120)

section('§6 after the popups close the composer owns its keys again')
await press(m, KEY.left, 300)
check('with the popup closed and the prompt empty, ← is the manager funnel again', sent.length === 1 && sent[0] === '/manager', JSON.stringify(sent))
m.unmount()
await settle(80)

section("§7 the Boot Settings face's JEV row: ←/→ flip it (no composer stands under this face)")
{
  const boot = await mountOffscreen(h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(BootSettingsScreen as never, { fullScene: { columns: COLS, rows: ROWS }, onClose: () => {} }))), COLS, ROWS)
  await waitFor(() => boot.screen().includes('CONTROL PLANE'), 4000)
  await settle(250)
  const reached = await selectMarked(boot, '❯ JEV')
  check('↓ reaches the JEV row on the boot face', reached && /❯ JEV\s+off\s/.test(bootJevRow(boot.lines())), bootJevRow(boot.lines()))
  keepFrame('boot-jev-before-right-178x51', 'the Boot Settings face with the JEV row selected, off', boot)
  await press(boot, KEY.right, 400)
  check('→ flips the JEV row on through the owner', setting.jevEnabled() === true && /❯ JEV\s+on\s/.test(bootJevRow(boot.lines())), bootJevRow(boot.lines()))
  keepFrame('boot-jev-after-right-178x51', 'after →: the JEV row reads on', boot)
  await press(boot, KEY.left, 400)
  check('← flips it back off', setting.jevEnabled() === false && /❯ JEV\s+off\s/.test(bootJevRow(boot.lines())), bootJevRow(boot.lines()))
  boot.unmount()
  await settle(80)
}

section('§8 the source pins')
{
  const prompt = readFileSync(join(REPO, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
  check('the composer subscribes to the popup predicate and folds it into the overlay union', prompt.includes("import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'") && prompt.includes('const popupUp = useSyncExternalStore(subscribePopupOwnsKeys, popupOwnsKeys, popupOwnsKeys)') && /const modalOverlayUp =[\s\S]{0,400}hasSuppressedDialogs \|\|\n\s+popupUp/.test(prompt))
  check('the raw ladder reads the predicate live at its hard skip', prompt.includes("if (modalOverlayUp || popupOwnsKeys() || compactWork?.read() === 'summary' || compactWork?.read() === 'detail') return"))
  check("the text input's byte gate carries the predicate too", /const keyboardOwnedByOverlay =[\s\S]{0,300}isLocalJSXCommandActive \|\|\n\s+popupUp/.test(prompt))
  check('the ladder still yields whole while another route surface covers the REPL', prompt.includes("if (currentSurfaceRoute().kind !== 'repl') return") && prompt.includes('!surfaceCovered && !keyboardOwnedByOverlay'))
  const predicate = readFileSync(join(REPO, 'src/utils/cockpit/popupOwnsKeys.ts'), 'utf8')
  check('the predicate is the union of the settings popup store and the files menu store', predicate.includes('return isSettingsPopupOpen() || isFilesMenuOpen()') && predicate.includes('subscribeSettingsPopup(listener)') && predicate.includes('subscribeFilesMenu(listener)'))
  const hints = [readFileSync(join(REPO, 'src/components/Settings/Jev.tsx'), 'utf8'), readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8'), readFileSync(join(REPO, 'src/components/MercuryFilesMenu.tsx'), 'utf8')]
  check('every popup that lists ←/→ in its hint rides one of the two stores the predicate folds', hints.every(src => /HINT = '[^']*[←→]/.test(src)))
  const cancel = readFileSync(join(REPO, 'src/hooks/useCancelRequest.ts'), 'utf8')
  check('the escape ladder stands down under any registered overlay (the popups register one)', cancel.includes('const overlayActive = useIsOverlayActive()') && cancel.includes('!overlayActive &&'))
  const settings = readFileSync(join(REPO, 'src/components/Settings/Settings.tsx'), 'utf8')
  check('the popup shell registers on the overlay stack and owns esc through its own road', settings.includes("useRegisterOverlay('settings')") && settings.includes("'confirm:no'"))
}

if (frameDir !== undefined) {
  const index = ['The popup owns every key it lists while open (↑↓ ←→ ↵ ⌫ esc): source renders at a 178x51 terminal of the real cockpit chrome (composer + lanes rail + popup slot) and the Boot Settings face. One file per state.', ...frames.map(frame => `${frame.name}.txt | ${frame.note}`)]
  writeFileSync(join(frameDir, 'index.txt'), index.join('\n') + '\n')
  console.log(`\nframes: ${frames.length} written to ${frameDir}`)
}
slot._resetFocusedSessionConnectorForTesting()
cap._setHeldMachineSeatReadingForTesting(null)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jev-popup-owns-keys: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
