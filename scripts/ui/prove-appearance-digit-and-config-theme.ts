#!/usr/bin/env bun
// gate-watch: src/components/ThemePicker.tsx src/commands/appearance/appearance.tsx src/components/Settings/Config.tsx
// gate-watch: src/components/CustomSelect/use-select-input.ts src/components/design-system/ThemeProvider.tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ASSET = {
  assets: 'scripts/ui/fixtures/appearance-digit/*.txt',
  generator: 'bun scripts/ui/prove-appearance-digit-and-config-theme.ts --write',
  check: 'bun scripts/ui/prove-appearance-digit-and-config-theme.ts',
  sources: 'scripts/ui/prove-appearance-digit-and-config-theme.ts src/components/ThemePicker.tsx src/commands/appearance/appearance.tsx src/components/Settings/Config.tsx src/components/mercury-ui/components.tsx',
}
if (registerOnlyRequested(ASSET)) process.exit(0)
const sourceRef = pinSourceRef()
const HOME = pinScratchHome('mercury-appearance-digit')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_THEME_PIN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const stills = join(import.meta.dir, 'fixtures', 'appearance-digit')
const write = process.argv.includes('--write')
if (write) mkdirSync(stills, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const save = (name: string, lines: string[]): void => {
  const frame = `${lines.join('\n')}\n`
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), frame)
  if (write) writeFileSync(join(stills, `${name}.txt`), frame)
  else if (!frameDir && sourceRef === undefined && process.platform === 'darwin' && existsSync(join(stills, `${name}.txt`))) {
    check(`${name}: the stored frame matches the source render`, readFileSync(join(stills, `${name}.txt`), 'utf8') === frame)
  }
}

const { enableConfigs, getGlobalConfig, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const storedTheme = (): string => String((getGlobalConfig() as { theme?: string }).theme ?? 'true-black')

const React = await import('react')
const h = React.createElement
const { Box, Text, ThemeProvider } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const settingsStore = await import('../../src/utils/cockpit/settingsPopup.ts')
const appearance = await import('../../src/commands/appearance/appearance.tsx')
const config = await import('../../src/commands/config/config.tsx')

function Harness({ columns, element }: { columns: number; element: React.ReactNode }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 60 }, (_, index) => h(Text, { key: index, wrap: 'truncate-end' }, `transcript row ${String(index + 1).padStart(2, '0')} ${'· '.repeat(columns)}`))),
    statusBand: h(Text, null, 'activity specimen'),
    statusBandActive: false,
    ...(element === null ? {} : { modal: h(Box, { width: '100%', flexDirection: 'column' }, element) }),
    modalScrollRef,
    bottom: h(PromptInput, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: element !== null,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(ThemeProvider as never, null, h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node)))
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
const inner = (line: string): string => line.replace(/^.*?│\s*/, '').replace(/\s*│[^│]*$/, '').trim()

section('§1 /appearance at 120x40: a digit applies the theme it names, and the words are true')
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const done: unknown[][] = []
  const element = await appearance.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, '')
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: (element ?? null) as React.ReactNode })), 120, 40)
  const painted = await waitFor(() => m.screen().includes('Mercury — appearance') && m.screen().includes('Black and white'), 10000)
  check('the appearance centre painted its three theme rows', painted, m.lines().filter(l => l.trim()).slice(0, 6).join(' | '))
  await settle(400)
  check('the panel opens on True Black with the default named in its row', rowOf(m, 'True Black').includes('❯') && rowOf(m, 'True Black').includes('(default)'), rowOf(m, 'True Black').trim())
  check('the stored theme before the press is the default', storedTheme() === 'true-black', storedTheme())
  save('appearance-panel-120x40', m.lines())
  m.push('3')
  const settled = await waitFor(() => done.length === 1, 8000)
  const words = String(done[0]?.[0] ?? '')
  check('3 settles the centre with the Black and white receipt', settled && words.startsWith('Theme set to Black and white'), words)
  check('and the words are true: Black and white is the stored theme', storedTheme() === 'mono', storedTheme())
  m.unmount()
  resetOverlayStackForTests()
}
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const done: unknown[][] = []
  const element = await appearance.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, '')
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: (element ?? null) as React.ReactNode })), 120, 40)
  await waitFor(() => m.screen().includes('Black and white'), 10000)
  await settle(400)
  check('reopened, the panel checks Black and white', rowOf(m, 'Black and white').includes('✓'), rowOf(m, 'Black and white').trim())
  m.push('2')
  const settled = await waitFor(() => done.length === 1, 8000)
  const words = String(done[0]?.[0] ?? '')
  check('2 names True Black and the stored theme follows', settled && words.startsWith('Theme set to True Black') && storedTheme() === 'true-black', `${words} · ${storedTheme()}`)
  m.unmount()
  resetOverlayStackForTests()
}

section('§2 /config at 120x40: a theme picked in the Theme sub-list stays when the popup is closed with esc')
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: null })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(200)
  const closed: unknown[] = []
  await config.call('', { messages: [], options: {}, getAppState: getDefaultAppState } as never)
  const opened = await waitFor(() => m.screen().includes('Mercury · config') && m.screen().includes('↵ save'), 10000)
  check('/config opens the popup', opened, m.lines().filter(l => l.trim()).slice(0, 6).join(' | '))
  await settle(300)
  m.push('/')
  await settle(120)
  for (const ch of 'theme') { m.push(ch); await settle(60) }
  m.push(KEY.down)
  const onTheme = await waitFor(() => /›\s+Theme\s/.test(m.screen()), 6000)
  check('the search lands the cursor on the Theme row, reading True Black', onTheme && rowOf(m, '› Theme').includes('True Black'), rowOf(m, 'Theme').trim())
  m.push(KEY.right)
  const sublist = await waitFor(() => m.screen().includes('1. Oasis dark') && m.screen().includes('3. Black and white'), 6000)
  check('→ opens the theme sub-list', sublist, m.lines().filter(l => /Dark|Black/.test(l)).join(' | '))
  m.push(KEY.up)
  await settle(150)
  m.push(KEY.enter)
  const picked = await waitFor(() => storedTheme() === 'dark' && /›\s+Theme\s+Oasis dark/.test(m.screen()), 6000)
  check('↑ ↵ picks Oasis dark: the row reads it and the theme is stored', picked, `${rowOf(m, 'Theme').trim()} · ${storedTheme()}`)
  save('config-theme-picked-120x40', m.lines())
  m.push(KEY.esc)
  await settle(600)
  check('esc keeps the picked theme: the file still reads dark', storedTheme() === 'dark', storedTheme())
  const stillOpen = m.screen().includes('Mercury · config')
  if (stillOpen) {
    check('the popup had nothing else to discard, so one esc closes it', false, 'the popup stayed open after esc')
  } else {
    check('one esc closes the popup: the theme was committed by its own ↵, not a draft', true)
  }
  settingsStore.closeSettingsPopup()
  await settle(60)
  m.unmount()
  resetOverlayStackForTests()
  void closed
}
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: null })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(200)
  let summary: unknown = 'unset'
  const original = settingsStore.closeSettingsPopup
  await config.call('', { messages: [], options: {}, getAppState: getDefaultAppState } as never)
  await waitFor(() => m.screen().includes('Mercury · config'), 10000)
  await settle(300)
  m.push('/')
  await settle(120)
  for (const ch of 'theme') { m.push(ch); await settle(60) }
  m.push(KEY.down)
  await waitFor(() => /›\s+Theme\s/.test(m.screen()), 6000)
  m.push(KEY.right)
  await waitFor(() => m.screen().includes('1. Dark'), 6000)
  m.push(KEY.down)
  await settle(150)
  m.push(KEY.enter)
  const back = await waitFor(() => storedTheme() === 'true-black' && rowOf(m, '› Theme').includes('True Black'), 6000)
  check('↓ ↵ picks True Black again and it is stored', back, `${rowOf(m, 'Theme').trim()} · ${storedTheme()}`)
  m.push(KEY.enter)
  await settle(400)
  check('↵ on the list closes the popup with the theme kept', !m.screen().includes('Mercury · config') && storedTheme() === 'true-black', storedTheme())
  void summary
  void original
  settingsStore.closeSettingsPopup()
  await settle(60)
  m.unmount()
  resetOverlayStackForTests()
}

await releaseScratchHome(HOME)
console.log(`\nappearance digit and config theme: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
