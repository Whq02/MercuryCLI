#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-model-name-matcher')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

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

const matcher = await import('../../src/utils/model/modelNameMatcher.ts')
type Match = import('../../src/utils/model/modelNameMatcher.ts').ModelNameMatch

section('§1 the table: typed forms → one id, several, or none (a typo never matches)')
{
  const rows = [
    ['claude-fable-5-1', 'Fable 5.1'], ['claude-fable-5', 'Fable 5'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5', 'Opus 5'],
    ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-sonnet-5', 'Sonnet 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-5.5', 'GPT-5.5'], ['glm-5.3', 'GLM-5.3'], ['glm-5.3-flash', 'GLM-5.3-Flash'],
    ['kimi-k3', 'Kimi K3'], ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
  ].map(([id, name]) => ({ id: id!, name }))
  const table: Array<[string, Match['kind'], string | string[]]> = [
    ['glm 5.3', 'match', 'glm-5.3'],
    ['GLM 5.3', 'match', 'glm-5.3'],
    ['glm-5.3', 'exact', 'glm-5.3'],
    ['Sonnet 5.5', 'match', 'claude-sonnet-5-5'],
    ['sonnet 5.5', 'match', 'claude-sonnet-5-5'],
    ['claude sonnet 5.5', 'match', 'claude-sonnet-5-5'],
    ['claude-sonnet-5-5', 'exact', 'claude-sonnet-5-5'],
    ['CLAUDE-OPUS-5-5', 'exact', 'claude-opus-5-5'],
    ['claude fable 5.1', 'match', 'claude-fable-5-1'],
    ['haiku 4.5', 'match', 'claude-haiku-4-5-20251001'],
    ['opus 5.5', 'match', 'claude-opus-5-5'],
    ['anthropic/claude-opus-5.5', 'exact', 'anthropic/claude-opus-5.5'],
    ['gpt 5.5', 'match', 'gpt-5.5'],
    ['kimi k3', 'match', 'kimi-k3'],
    ['glm 5.3 flash', 'match', 'glm-5.3-flash'],
    ['opus 4', 'ambiguous', ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6']],
    ['gpt 6', 'ambiguous', ['gpt-6-astra', 'gpt-6-sol']],
    ['claude-banana-9', 'none', []],
    ['claude-sonnet-5-6', 'none', []],
    ['sonet 5.5', 'none', []],
    ['banana', 'none', []],
  ]
  for (const [typed, kind, want] of table) {
    const got = matcher.matchModelName(typed, rows)
    const ids = got.kind === 'exact' || got.kind === 'match' ? got.id : got.kind === 'ambiguous' ? got.candidates : []
    const same = Array.isArray(want) ? JSON.stringify(ids) === JSON.stringify(want) || (want.length === 0 && got.kind === 'none') : ids === want
    check(`${JSON.stringify(typed)} → ${kind}${Array.isArray(want) ? (want.length ? ` ${want.join(' | ')}` : '') : ` ${want}`}`, got.kind === kind && same, JSON.stringify(got))
  }
  const banana = matcher.matchModelName('claude-banana-9', rows)
  check('a typo that matches nothing names the nearest listed ids for the ask, never a save', banana.kind === 'none' && banana.nearest.length > 0 && banana.nearest.length <= 3 && banana.nearest.every(id => rows.some(row => row.id === id)), JSON.stringify(banana))
  const typo = matcher.matchModelName('claude-sonnet-5-6', rows)
  check('a one-digit typo of a listed id is NOT taken as that id; the nearest names it', typo.kind === 'none' && typo.nearest[0] === 'claude-sonnet-5-5', JSON.stringify(typo))
  const said = matcher.matchModelName('glm 5.3', rows)
  check('a confident match carries the words said back: typed → id', said.kind === 'match' && said.said === 'glm 5.3 → glm-5.3', JSON.stringify(said))
  check('the key folds case, spaces, dots and hyphens, the vendor word and a date tail', matcher.modelNameKey('Claude Haiku 4.5') === 'haiku45' && matcher.modelNameKey('claude-haiku-4-5-20251001') === 'haiku45' && matcher.modelNameKey('GLM-5.3') === 'glm53' && matcher.modelNameKey('anthropic/claude-opus-5.5') === 'anthropicclaudeopus55')
}

section('§2 the three roads read the one module')
{
  const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
  check('/model’s typed name rides matchReachableModelName and asks through the picker when nothing or several match', read('src/commands/model/mercuryModel.tsx').includes("import { matchReachableModelName, modelNameAskWords } from '../../utils/model/modelNameRoad.js'") && read('src/commands/model/mercuryModel.tsx').includes('modelNameAskWords(matched'))
  check('the --model flag of mercury run and the launcher rides the same matcher', read('src/main.tsx').includes("import('./utils/model/modelNameRoad.js')") && read('src/main.tsx').includes("if (runMode) failCli(modelNameHeadlessRefusal(matched, '--model'), 1)"))
  check('the Crewmate tool’s model parameter rides the same matcher', read('src/tools/AgentTool/AgentTool.tsx').includes("import { matchReachableModelName, modelNameHeadlessRefusal } from '../../utils/model/modelNameRoad.js'") && read('src/tools/AgentTool/AgentTool.tsx').includes("modelNameHeadlessRefusal(matchedModel, 'model')"))
  const road = await import('../../src/utils/model/modelNameRoad.ts')
  check('the road leaves the family words and aliases to their own owners', road.matchReachableModelName('opus') === null && road.matchReachableModelName('gpt') === null && road.matchReachableModelName('default') === null)
  const live = road.matchReachableModelName('sonnet 5.5')
  check('the road reads the catalogue this session reaches: sonnet 5.5 → claude-sonnet-5-5', live?.kind === 'match' && live.id === 'claude-sonnet-5-5', JSON.stringify(live))
  const words = road.modelNameAskWords({ kind: 'none', typed: 'claude-banana-9', nearest: ['claude-opus-5-5'] }, id => (id === 'claude-opus-5-5' ? 'Opus 5.5' : id))
  check('the ask words name the typed string and the nearest rows', words === "'claude-banana-9' names no listed model (nearest: Opus 5.5); pick a row below", words)
  check('the headless refusal names the candidates when several match', road.modelNameHeadlessRefusal({ kind: 'ambiguous', typed: 'gpt 6', candidates: ['gpt-6-astra', 'gpt-6-sol'] }, '--model') === "--model 'gpt 6' could be gpt-6-astra or gpt-6-sol — name one.")
  const window = road.matchReachableModelName('claude-sonnet-5-5[1m]')
  check('the [1m] window is a window, not a model: the listed id keeps its window on the way through', window?.kind === 'exact' && window.id === 'claude-sonnet-5-5[1m]', JSON.stringify(window))
  const looseWindow = road.matchReachableModelName('sonnet 5.5[1m]')
  check('a loose name with the window matches and keeps the window', looseWindow?.kind === 'match' && looseWindow.id === 'claude-sonnet-5-5[1m]', JSON.stringify(looseWindow))
  const unlistedAsked = road.matchReachableModelName('gemini-3.5-flash-proof-only')
  const unlistedPassed = road.matchReachableModelName('gemini-3.5-flash-proof-only', 'pass')
  check('an id-shaped word the catalogue does not list asks by default (the /model picker) and passes to the provider road on request (--model at boot, where the catalogue can lag the provider)', unlistedAsked?.kind === 'none' && unlistedPassed === null, JSON.stringify([unlistedAsked, unlistedPassed]))
  const looseMiss = road.matchReachableModelName('gemini three point five', 'pass')
  check('a loose name that matches nothing never passes through: it asks or refuses with the nearest rows', looseMiss?.kind === 'none', JSON.stringify(looseMiss))
  check('the --model flag passes unlisted id-shaped words to the provider road', read('src/main.tsx').includes("matchReachableModelName(userSpecifiedModel, 'pass')"))
}

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))

section('§3 the validation probe: an endpoint that answers 404 is a refusal, never a pass')
const hits: string[] = []
const fixture = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk as Buffer))
  request.on('end', () => {
    let model = '?'
    try { model = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }).model ?? '?') } catch { model = '?' }
    hits.push(`${request.method} ${request.url} model=${model}`)
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${model} is not served on this account` } }))
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', () => resolve()))
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`
{
  const { validateModel } = await import('../../src/utils/model/validateModel.ts')
  const verdict = await validateModel('claude-banana-9')
  check('the probe reached the endpoint with the typed id', hits.length >= 1 && hits[0]!.endsWith('model=claude-banana-9'), JSON.stringify(hits))
  check('a 404 from the endpoint makes the id invalid, with the reason', verdict.valid === false && /Model not found/.test(verdict.error ?? ''), JSON.stringify(verdict))
}

section('§4 the cockpit: a typed name that matches is said back; one that does not opens the picker asking, and nothing is saved')
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const settingsStore = await import('../../src/utils/cockpit/settingsPopup.ts')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const TITLE = 'Mercury · model'
const settingsPath = join(HOME, 'settings.json')
const engineOf = (): Record<string, unknown> => ((existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>).engine : undefined) as Record<string, unknown> | undefined) ?? {}

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
    modal: h(Box, { width: '100%', flexDirection: 'column' }, element),
    modalScrollRef,
    bottom: h(PromptInput, {
      debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
      setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
      verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
      showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
      onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
      helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: true,
      insertTextRef: insertRef,
    } as never),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))
async function typedModel(args: string): Promise<{ m: Mounted; done: unknown[][] }> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const done: unknown[][] = []
  const element = await modelCommand.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, args)
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120, element: (element ?? null) as React.ReactNode })), 120, 40)
  await waitFor(() => m.screen().includes('transcript row'), 8000)
  return { m, done }
}
async function closeScene(m: Mounted): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  m.unmount()
  resetOverlayStackForTests()
}
{
  const before = JSON.stringify(engineOf())
  const scene = await typedModel('claude-banana-9')
  const asked = await waitFor(() => scene.m.screen().includes(TITLE) && scene.m.screen().includes("'claude-banana-9' names no listed model"), 10000)
  check('/model claude-banana-9 opens the picker with the ask: the typed string, the nearest rows, pick a row below', asked, scene.m.lines().filter(l => /names no|Mercury · model|refused|Model set/.test(l)).join(' | '))
  check('nothing was saved as the default model', JSON.stringify(engineOf()) === before && (engineOf().model === undefined || engineOf().model !== 'claude-banana-9'), JSON.stringify(engineOf()))
  check('the command did not settle on a switch or a refusal: the picker asks instead', scene.done.length === 0, JSON.stringify(scene.done))
  await closeScene(scene.m)
}
{
  const scene = await typedModel('Sonnet 5.5')
  const said = await waitFor(() => scene.done.length === 1, 20000)
  const words = String(scene.done[0]?.[0] ?? '')
  check('/model Sonnet 5.5 is matched and said back on its own line before the switch road speaks', said && words.startsWith('Sonnet 5.5 → claude-sonnet-5-5\n'), words)
  check('the switch road received the id, not the typed words: the probe asked the endpoint for claude-sonnet-5-5', hits.some(hit => hit.endsWith('model=claude-sonnet-5-5')) && !/is not a model id any provider family declares/.test(words), `${JSON.stringify(hits)} · ${words}`)
  check('the endpoint’s 404 is a refusal and nothing is saved', /Model not found/.test(words) && engineOf().model === undefined, `${words} · ${JSON.stringify(engineOf())}`)
  await closeScene(scene.m)
}
{
  const scene = await typedModel('gpt 6')
  const asked = await waitFor(() => scene.m.screen().includes(TITLE) && scene.m.screen().includes("'gpt 6' could be") || scene.m.screen().includes("'gpt 6' names no listed model"), 10000)
  check('/model gpt 6 (several or no reachable GPT rows) opens the picker asking', asked, scene.m.lines().filter(l => /gpt 6|Mercury · model/.test(l)).join(' | '))
  await closeScene(scene.m)
}

fixture.close()
await releaseScratchHome(HOME)
console.log(`\nmodel name matcher: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
