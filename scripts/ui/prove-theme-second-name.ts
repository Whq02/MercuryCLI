#!/usr/bin/env bun
// gate-watch: src/commands/appearance/index.ts src/commands.ts src/utils/suggestions/commandSuggestions.ts src/components/HelpV2/Commands.tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ASSET = {
  assets: 'scripts/ui/fixtures/theme-second-name/*.txt',
  generator: 'bun scripts/ui/prove-theme-second-name.ts --write',
  check: 'bun scripts/ui/prove-theme-second-name.ts',
  sources: 'scripts/ui/prove-theme-second-name.ts src/commands/appearance/index.ts src/components/PromptInput/PromptInputFooterSuggestions.tsx src/utils/suggestions/commandSuggestions.ts',
}
if (registerOnlyRequested(ASSET)) process.exit(0)
const sourceRef = pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-theme-second-name')
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
const stills = join(import.meta.dir, 'fixtures', 'theme-second-name')
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

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const commandsModule = await import('../../src/commands.ts')
const commands = await commandsModule.getCommands(process.cwd())

section('§1 /theme is a second name of /appearance: it resolves, it is a known name, its line says theme')
{
  const found = commandsModule.findCommand('theme', commands)
  check('/theme resolves to the appearance command', found !== undefined && found.name === 'appearance', found?.name)
  check('the built-in names carry theme', commandsModule.builtInCommandNames().has('theme'))
  const appearance = commands.find(c => c.name === 'appearance')
  check('the appearance line names the second spelling and the word theme', appearance !== undefined && /\(also \/theme\)/.test(appearance.description) && /theme/i.test(appearance.description), appearance?.description)
  check('no other command claims the name', commands.filter(c => c.name === 'theme' || c.aliases?.includes('theme')).length === 1)
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

function Harness({ columns, element }: { columns: number; element: React.ReactNode }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [helpOpen, setHelpOpen] = React.useState(false)
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
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands, agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen, setHelpOpen, hasSuppressedDialogs: false, isLocalJSXCommandActive: element !== null,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(ThemeProvider as never, null, h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node)))
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''

section('§2 the composer at 120x40: typing /theme offers the appearance centre')
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: null })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  await settle(300)
  for (const ch of '/them') { m.push(ch); await settle(80) }
  const offered = await waitFor(() => /\/appearance \(theme\)/.test(m.screen()), 6000)
  check('/them offers /appearance (theme) with its line naming the theme', offered && rowOf(m, '/appearance (theme)').includes('theme'), m.lines().filter(l => l.includes('/appearance') || l.includes('/them')).join(' | '))
  save('composer-theme-typeahead-120x40', m.lines())
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
  resetOverlayStackForTests()
}

section('§3 /help: the commands tab lists /appearance in its group with the word theme and the second name in its line')
{
  const { groupCommandsByDomain } = await import('../../src/components/HelpV2/commandDomains.ts')
  const groups = groupCommandsByDomain(commands)
  const group = groups.find(g => g.commands.some(c => c.name === 'appearance'))
  check('the appearance command sits in the appearance group of the commands tab', group !== undefined && group.key === 'appearance', group?.key)
  const appearance = group?.commands.find(c => c.name === 'appearance')
  const line = appearance === undefined ? '' : `/${appearance.name}  ${commandsModule.formatDescriptionWithSource(appearance)}`
  check('the line the tab paints reads /appearance with the word theme and names /theme beside it', /^\/appearance\s+.*theme.*\(also \/theme\)/.test(line), line)
  check('no row of the tab is a bare /theme (the second name rides the appearance line, not a row of its own)', !groups.some(g => g.commands.some(c => c.name === 'theme')))
}

await releaseScratchHome(HOME)
console.log(`\ntheme second name: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
