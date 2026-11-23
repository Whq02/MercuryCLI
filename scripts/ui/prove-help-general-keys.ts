#!/usr/bin/env bun
// gate-watch: src/screen/help/HelpV2.tsx src/screen/theme/Tabs.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, KEY, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-help-general-keys')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const save = (name: string, lines: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}
const PGDN = '\x1b[6~'
const PGUP = '\x1b[5~'

const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { Help } = await import('../../src/screen/help/HelpV2.tsx')
const { builtinCommands } = await import('../../src/commands/catalogue/commands.ts')
const defaultComposer = await import('../../src/screen/composer/Composer.tsx')
const Composer = defaultComposer.default
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const COMMANDS = builtinCommands()

let setModal: (node: React.ReactNode) => void = () => {}
function Harness({ columns }: { columns: number }): React.ReactNode {
  const [modal, updateModal] = React.useState<React.ReactNode>(null)
  setModal = updateModal
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 100 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, 'T'.repeat(columns)))),
    statusBand: h(Text, null, 'live transcript behind the popup'),
    statusBandActive: false,
    modal: modal === null ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, modal),
    modalScrollRef,
    bottom: h(Composer, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: modal !== null,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

const FOOTER_HINT = 'esc close'
const TAB_ROW = 'general'
const tabsLineOf = (m: Mounted): string => m.lines().find(l => l.includes(TAB_ROW) && l.includes('commands')) ?? ''
const footerOf = (m: Mounted): string => m.lines().findLast(l => l.includes('esc close')) ?? ''
const onGeneral = (m: Mounted): boolean => m.screen().includes('! for shell mode')
const onCommands = (m: Mounted): boolean => m.screen().includes('Browse default commands')
const onShortcuts = (m: Mounted): boolean => m.screen().includes('everyday') && !onGeneral(m)

async function openHelp(columns: number, rows: number): Promise<Mounted> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows, { mouseTracking: true })
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(150)
  setModal(h(Help, { commands: COMMANDS, onClose: () => setModal(null) }))
  await waitFor(() => m.screen().includes('Mercury — help') && tabsLineOf(m).includes('commands'), 8000)
  await settle(400)
  return m
}
async function closeHelp(m: Mounted): Promise<void> {
  m.unmount()
  resetOverlayStackForTests()
  setModal(null)
}

const headerMarked = (line: string, tab: string): boolean => {
  const at = line.indexOf(tab)
  return at >= 0 && (line[at - 1] === ' ' || at === 0)
}

console.log('============================================================')
console.log(' /help general tab at 80x30 — no inert keys, honest footer')
console.log('============================================================')

const m = await openHelp(80, 30)
const lines = m.lines()
save('help-general-80x30', lines)

{
  const shortcutRows = ['for command palette', 'to switch model', 'to edit in $EDITOR', '/keybindings to customize']
  const bodyBottom = lines.findLastIndex(l => shortcutRows.some(s => l.includes(s)))
  check('80x30: the general tab body fits — every shortcut row paints, no overflow marker', bodyBottom >= 0 && !m.screen().includes('more · /help lists every shortcut'), `fix the row budget in src/screen/composer/ComposerHelpMenu.tsx so every shortcut row paints at 80x30 without the overflow marker; last shortcut row at ${bodyBottom}`)

  const footer = footerOf(m)
  check('80x30: the footer names the keys that work on the general tab', footer.includes('switch tabs') && footer.includes(FOOTER_HINT), `fix the footer prop passed to CommandCenter in src/screen/help/HelpV2.tsx so the general tab footer names the tab-switch keys and esc close; footer = ${footer}`)

  const goGeneral = async (): Promise<boolean> => {
    for (let i = 0; i < 8 && !onGeneral(m); i++) {
      m.push(KEY.left)
      await settle(250)
    }
    return onGeneral(m)
  }

  await goGeneral()
  m.push(KEY.up)
  await settle(300)
  check('80x30: ↑ is not inert — the selection wraps to the shortcuts tab', onShortcuts(m), `fix the useInput in src/screen/help/HelpV2.tsx so up moves the tab selection while the general tab body does not scroll; tabs line = ${tabsLineOf(m)}`)
  save('help-general-80x30-up', m.lines())

  await goGeneral()
  m.push(KEY.down)
  await settle(300)
  check('80x30: ↓ is not inert — the selection moves to the commands tab', onCommands(m), `fix the useInput in src/screen/help/HelpV2.tsx so down moves the tab selection while the general tab body does not scroll; tabs line = ${tabsLineOf(m)}`)
  save('help-general-80x30-down', m.lines())
  const commandsFooter = footerOf(m)
  check('80x30: on commands the body hint owns the keys (the footer claim is tab-honest)', m.lines().some(l => l.includes('↑↓ move · pgup/pgdn page')) || !commandsFooter.includes('switch tabs'), `on the commands tab either Commands.tsx must paint its key hint row or the HelpV2.tsx footer must drop the switch tabs claim (src/screen/help); footer = ${commandsFooter}`)

  await goGeneral()
  m.push(PGDN)
  await settle(300)
  check('80x30: pgdn is not inert — the selection moves to commands', onCommands(m), `fix the useInput in src/screen/help/HelpV2.tsx so pageDown moves the tab selection while the general tab body does not scroll; tabs line = ${tabsLineOf(m)}`)

  await goGeneral()
  m.push(PGUP)
  await settle(300)
  check('80x30: pgup is not inert — the selection wraps back to shortcuts', onShortcuts(m), `fix the useInput in src/screen/help/HelpV2.tsx so pageUp moves the tab selection while the general tab body does not scroll; tabs line = ${tabsLineOf(m)}`)
}
await closeHelp(m)

console.log('------------------------------------------------------------')
console.log(' the overflow regime keeps its pager (80x24 regression guard)')
console.log('------------------------------------------------------------')
{
  const m = await openHelp(80, 24)
  const footer = footerOf(m)
  check('80x24: the overflowing body keeps the scroll pager footer', footer.includes('pgup/pgdn'), `when the body overflows (bodyScrolls in src/screen/help/HelpV2.tsx) the footer must keep the pgup/pgdn pager text; footer = ${footer}`)
  const before = m.screen()
  m.push(KEY.down)
  await settle(300)
  check('80x24: ↓ scrolls the overflowing body (not a tab jump)', m.screen() !== before && !tabsLineOf(m).startsWith('                                                                                '), `when the body overflows, down must scroll the body and not switch tabs: check isActive of the useInput in src/screen/help/HelpV2.tsx; tabs line = ${tabsLineOf(m)}`)
  await closeHelp(m)
}

console.log('------------------------------------------------------------')
console.log(' the commands tab keeps its own keys (120x40 regression guard)')
console.log('------------------------------------------------------------')
{
  const m = await openHelp(120, 40)
  const tabs = tabsLineOf(m)
  check('120x40: /help opened on the general tab', tabs.includes('general'), `Help must open on the general tab (useState initial value in src/screen/help/HelpV2.tsx); tabs line = ${tabs}`)
  m.push(KEY.right)
  await settle(300)
  const moved = await waitFor(() => m.screen().includes('Browse default commands'), 4000)
  check('120x40: → switches to the commands tab', moved, `right arrow must change the tab in the Tabs component (src/screen/theme/Tabs.tsx); top lines = ${m.lines().slice(0, 8).join(' | ')}`)
  const listRow = m.lines().find(l => l.includes('↑↓ move · pgup/pgdn page'))
  check('120x40: the commands tab keeps its own key hint row', listRow !== undefined, `the commands tab must paint the key hint row (src/screen/help/Commands.tsx); row = ${(listRow ?? '').trim()}`)
  const before = m.screen()
  m.push(KEY.down)
  await settle(300)
  m.push(KEY.down)
  await settle(300)
  check('120x40: ↓ still moves the command list, not the tab row', m.screen() !== before && m.screen().includes('Browse default commands'), 'on the commands tab down must reach the command list: the tab-row useInput in src/screen/help/HelpV2.tsx must stay inactive and the useInput in Commands.tsx must handle down')
  await closeHelp(m)
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
