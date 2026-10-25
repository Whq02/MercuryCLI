#!/usr/bin/env bun
// gate-watch: src/components/PromptInput/useComposerAttachments.ts src/input-core/composer-document.ts src/utils/pasteStore.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-paste-tabs')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const document = await import('../../src/input-core/composer-document.ts')
section('§1 the rules: the line rule keeps tabs, the composer rule expands them')
{
  const raw = 'TAB1\tcolB\r\nTAB2\tcolB\r\nTAB3\tcolB'
  const lines = (document as Record<string, unknown>).normalizePastedLines as ((raw: string) => string) | undefined
  check('the line rule folds CRLF and keeps every tab', lines !== undefined && lines(raw) === 'TAB1\tcolB\nTAB2\tcolB\nTAB3\tcolB', lines === undefined ? 'no line rule' : JSON.stringify(lines(raw)))
  check('the composer rule still expands tabs for the text field', document.normalizePastedInput(raw) === 'TAB1    colB\nTAB2    colB\nTAB3    colB', JSON.stringify(document.normalizePastedInput(raw)))
}

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
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
const pending = await import('../../src/input-core/pending-input.ts')

function Harness({ columns }: { columns: number }): React.ReactNode {
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
    modalScrollRef,
    bottom: h(PromptInput, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: false,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(ThemeProvider as never, null, h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node)))

section('§2 the composer at 120x40: a pasted chip keeps the bytes the model reads, tabs included')
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120 })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(300)
  const pasted = 'TAB1\tcolB\r\nTAB2\tcolB\r\nTAB3\tcolB\r\nTAB4\tcolB'
  m.push(`\x1b[200~${pasted}\x1b[201~`)
  const chip = await waitFor(() => /Pasted text #\d+ \+\d+ lines/.test(m.screen()), 8000)
  check('four pasted lines become a chip in the composer', chip, m.lines().filter(l => l.includes('Pasted') || l.includes('TAB')).join(' | '))
  const store = join(HOME, 'paste-cache')
  const stored = await waitFor(() => existsSync(store) && readdirSync(store).some(name => name.endsWith('.txt')), 6000)
  check('the paste store holds the chip', stored, existsSync(store) ? readdirSync(store).join(',') : 'no store')
  const files = stored ? readdirSync(store).filter(name => name.endsWith('.txt')) : []
  const content = files.length > 0 ? readFileSync(join(store, files[0]!), 'utf8') : ''
  check('the stored content keeps every tab and folds CRLF to LF: byte for byte what was pasted', content === 'TAB1\tcolB\nTAB2\tcolB\nTAB3\tcolB\nTAB4\tcolB', JSON.stringify(content))
  const held = pending.pastedContents()
  const first = Object.values(held)[0] as { content?: string } | undefined
  check('the composer’s own record of the paste carries the tabs too', first?.content === 'TAB1\tcolB\nTAB2\tcolB\nTAB3\tcolB\nTAB4\tcolB', JSON.stringify(first?.content))
  check('the composer text shows the chip reference, never four spaces', !m.screen().includes('TAB1    colB'), m.lines().filter(l => l.includes('TAB1')).join(' | '))
  m.unmount()
  resetOverlayStackForTests()
}

section('§3 a decomposed paste mid-draft: the store holds NFC and the caret lands after the pasted text, so the next letter follows it')
for (const [label, payload, composedForm] of [['a Latin letter and its combining acute', 'e\u0301', '\u00e9'], ['an Arabic alef and a maddah above', '\u0627\u0653', '\u0622'], ['a Hebrew presentation form', '\ufb2a', '\u05e9\u05c1'], ['a Hangul jamo pair', '\u1100\u1161', '\uac00']] as const) {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120 })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(300)
  m.push('abXY')
  await waitFor(() => pending.text() === 'abXY', 4000)
  m.push('\x1b[D')
  m.push('\x1b[D')
  await settle(200)
  m.push(`\x1b[200~${payload}\x1b[201~`)
  const pasted = await waitFor(() => pending.text() === `ab${composedForm}XY`, 4000)
  check(`${label}: the pasted draft is stored in NFC`, pasted, JSON.stringify(pending.text()))
  await settle(200)
  m.push('Z')
  const typed = await waitFor(() => pending.text().includes('Z'), 4000)
  check(`${label}: the letter typed after the paste follows the pasted text`, typed && pending.text() === `ab${composedForm}ZXY`, JSON.stringify(pending.text()))
  m.unmount()
  resetOverlayStackForTests()
}

await releaseScratchHome(HOME)
console.log(`\npaste keeps tabs: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
