#!/usr/bin/env bun
// gate-watch: src/components/Settings/Config.tsx src/utils/thinking.ts src/utils/model/capabilities.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ASSET = {
  assets: 'scripts/ui/fixtures/config-thinking/*.txt',
  generator: 'bun scripts/ui/prove-config-thinking-row.ts --write',
  check: 'bun scripts/ui/prove-config-thinking-row.ts',
  sources: 'scripts/ui/prove-config-thinking-row.ts src/components/Settings/Config.tsx src/components/SettingsPopupSlot.tsx src/components/Settings/Settings.tsx',
}
if (registerOnlyRequested(ASSET)) process.exit(0)
const sourceRef = pinSourceRef()
const HOME = pinScratchHome('mercury-config-thinking')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_THINKING_BUDGET', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const stills = join(import.meta.dir, 'fixtures', 'config-thinking')
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

const settingsPath = join(HOME, 'settings.json')
const HAIKU = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-5-5'
writeFileSync(settingsPath, JSON.stringify({ engine: { model: HAIKU } }))
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const engineOf = (): Record<string, unknown> => ((existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>).engine : undefined) as Record<string, unknown> | undefined) ?? {}
const { shouldEnableThinkingByDefault } = await import('../../src/utils/thinking.ts')

section('§1 the row and the engine agree on what an absent key means')
{
  resetSettingsCache()
  check('with no engine.reasoning key the engine thinks (the default-on rule)', shouldEnableThinkingByDefault() === true)
  const config = await import('../../src/components/Settings/Config.tsx')
  check('a model that takes the control: the row applies', config.thinkingRowApplicability(HAIKU).applies === true)
  const always = config.thinkingRowApplicability(SONNET)
  check('a model whose thinking is always on says so in the row', always.applies === false && always.naText === 'n/a — Sonnet 5.5 keeps thinking on', JSON.stringify(always))
}

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
const config = await import('../../src/commands/config/config.tsx')

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
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
const thinkingRow = (m: Mounted): string => rowOf(m, '› Thinking').replace(/^.*?› Thinking/, '› Thinking').replace(/\s*│.*$/, '').replace(/\s+/g, ' ').trim()

async function openConfigOnThinking(): Promise<{ m: Mounted; closed: unknown[] }> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetSettingsCache()
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120 })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(200)
  const closed: unknown[] = []
  await config.call('', { messages: [], options: {}, getAppState: getDefaultAppState } as never)
  const opened = await waitFor(() => m.screen().includes('Mercury · config') && m.screen().includes('←/→ change'), 10000)
  check('/config opens with the footer promising ←/→ change · ↵ save', opened, m.lines().filter(l => l.trim()).slice(0, 6).join(' | '))
  await settle(300)
  m.push('/')
  await settle(120)
  for (const ch of 'think') { m.push(ch); await settle(60) }
  m.push(KEY.down)
  const onRow = await waitFor(() => /›\s+Thinking\s/.test(m.screen()), 6000)
  check('the search lands the cursor on the Thinking row', onRow, rowOf(m, 'Thinking').trim())
  return { m, closed }
}
async function closeScene(m: Mounted): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  m.unmount()
  resetOverlayStackForTests()
}

section('§2 /config on Haiku 4.5 (a model that takes the control): the row changes with the keys the footer names')
{
  const { m } = await openConfigOnThinking()
  check('with no key saved the row reads on, as the engine runs', thinkingRow(m).endsWith('on'), thinkingRow(m))
  check('the file has no reasoning key yet', engineOf().reasoning === undefined, JSON.stringify(engineOf()))
  save('thinking-row-on-120x40', m.lines())
  m.push(KEY.right)
  const off = await waitFor(() => thinkingRow(m).endsWith('off') && engineOf().reasoning === false, 6000)
  check('→ turns the row off and writes engine.reasoning false', off, `${thinkingRow(m)} · ${JSON.stringify(engineOf())}`)
  save('thinking-row-off-120x40', m.lines())
  m.push(KEY.right)
  const on = await waitFor(() => thinkingRow(m).endsWith('on') && engineOf().reasoning === undefined, 6000)
  check('→ again turns it on: the key is removed and the engine default (on) runs', on, `${thinkingRow(m)} · ${JSON.stringify(engineOf())}`)
  m.push(KEY.left)
  const offAgain = await waitFor(() => thinkingRow(m).endsWith('off') && engineOf().reasoning === false, 6000)
  check('← is the other direction of the same change', offAgain, `${thinkingRow(m)} · ${JSON.stringify(engineOf())}`)
  m.push(KEY.enter)
  const saved = await waitFor(() => !m.screen().includes('Mercury · config'), 6000)
  check('↵ saves and closes with thinking off kept in the file', saved && engineOf().reasoning === false, JSON.stringify(engineOf()))
  await closeScene(m)
}
{
  const { m } = await openConfigOnThinking()
  check('reopened, the row reads the saved off', thinkingRow(m).endsWith('off'), thinkingRow(m))
  m.push(KEY.right)
  await waitFor(() => thinkingRow(m).endsWith('on'), 6000)
  m.push(KEY.esc)
  const reverted = await waitFor(() => thinkingRow(m).endsWith('off') && engineOf().reasoning === false, 6000)
  check('esc discards the draft: the row and the file read off again', reverted, `${thinkingRow(m)} · ${JSON.stringify(engineOf())}`)
  m.push(KEY.right)
  await waitFor(() => thinkingRow(m).endsWith('on') && engineOf().reasoning === undefined, 6000)
  m.push(KEY.enter)
  await waitFor(() => !m.screen().includes('Mercury · config'), 6000)
  check('↵ keeps thinking on: the key is gone', engineOf().reasoning === undefined, JSON.stringify(engineOf()))
  await closeScene(m)
}

section('§3 /config on Sonnet 5.5 (thinking always on): the row says why it cannot change')
{
  writeFileSync(settingsPath, JSON.stringify({ engine: { model: SONNET } }))
  const { m } = await openConfigOnThinking()
  check('the row names the model and says it keeps thinking on', thinkingRow(m).includes('n/a — Sonnet 5.5 keeps thinking on'), thinkingRow(m))
  m.push(KEY.right)
  await settle(300)
  check('→ changes nothing and writes nothing', thinkingRow(m).includes('keeps thinking on') && engineOf().reasoning === undefined, `${thinkingRow(m)} · ${JSON.stringify(engineOf())}`)
  check('the reason stands under the row', m.screen().includes('thinks on every request'), m.lines().filter(l => l.includes('thinks on')).join(' | '))
  save('thinking-row-always-on-120x40', m.lines())
  await closeScene(m)
}

await releaseScratchHome(HOME)
console.log(`\nconfig thinking row: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
