#!/usr/bin/env bun
// gate-watch: src/components/MercuryModelPicker.tsx src/utils/model/modelPickerGroups.ts src/utils/model/modelPickerFooter.ts
// gate-watch: src/commands/model/mercuryModel.tsx src/commands/localsetup/words.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ASSET = {
  assets: 'scripts/ui/fixtures/model-picker-typed/*.txt',
  generator: 'bun scripts/ui/prove-model-picker-typed-letters.ts --write',
  check: 'bun scripts/ui/prove-model-picker-typed-letters.ts',
  sources: 'scripts/ui/prove-model-picker-typed-letters.ts src/components/MercuryModelPicker.tsx src/utils/model/modelPickerGroups.ts src/utils/model/modelPickerFooter.ts src/commands/model/mercuryModel.tsx src/commands/localsetup/words.ts',
}
if (registerOnlyRequested(ASSET)) process.exit(0)
const sourceRef = pinSourceRef()
const HOME = pinScratchHome('mercury-picker-typed')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const stills = join(import.meta.dir, 'fixtures', 'model-picker-typed')
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

const words = await import('../../src/utils/model/modelPickerGroups.ts')
const { modelPickerFooter } = await import('../../src/utils/model/modelPickerFooter.ts')
const { LOCAL_SETUP_PICKER_OFFER } = await import('../../src/commands/localsetup/words.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))

section('§1 the words: no bare letter is a key in the picker; the chords are named where they act')
{
  const hint: string = words.MODEL_PICKER_HINT
  check('the rows’ hint names the context chord and no bare letter', hint.includes('ctrl+w context') && !/ c context/.test(hint) && hint.includes('tab to search'), hint)
  check('the effort strip names its chord', (words as Record<string, unknown>).MODEL_PICKER_EFFORT_WORDS === 'ctrl+e changes it', String((words as Record<string, unknown>).MODEL_PICKER_EFFORT_WORDS))
  check('the box at rest says to type', words.MODEL_PICKER_FILTER_PLACEHOLDER === 'type to search by name or id', words.MODEL_PICKER_FILTER_PLACEHOLDER)
  check('the local offer names the command, not a letter', LOCAL_SETUP_PICKER_OFFER.includes('/localsetup') && !/\bs sets/.test(LOCAL_SETUP_PICKER_OFFER), LOCAL_SETUP_PICKER_OFFER)
  check('the legend at width carries the chord', modelPickerFooter({ gated: false }, 120).includes('ctrl+w context') && !modelPickerFooter({ gated: false }, 120).includes(' c context'), modelPickerFooter({ gated: false }, 120))
  const search = (words as Record<string, unknown>).isSearchCharacter as ((input: string, key: { ctrl: boolean; meta: boolean; tab: boolean }) => boolean) | undefined
  const plain = { ctrl: false, meta: false, tab: false }
  check('a letter, a digit, a dot and a space are search characters; control bytes, chords, tab and delete are not', search !== undefined && ['s', 'S', '5', '.', ' ', '-'].every(c => search(c, plain)) && !search('\x1b', plain) && !search('\r', plain) && !search('\x7f', plain) && !search('e', { ...plain, ctrl: true }) && !search('e', { ...plain, meta: true }) && !search('\t', { ...plain, tab: true }) && !search('', plain))
}

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
const CTRL_E = '\x05'
const CTRL_W = '\x17'
const settingsPath = join(HOME, 'settings.json')
const readSettings = (): Record<string, unknown> => (existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>) : {})
const engineOf = (): Record<string, unknown> => ((readSettings().engine as Record<string, unknown> | undefined) ?? {})

type Scene = { m: Mounted; done: unknown[][]; columns: number; rows: number }
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

async function openPicker(columns: number, rows: number, typed = ''): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const done: unknown[][] = []
  const element = await modelCommand.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, typed)
  check(`${columns}x${rows}: /model hands the session a picker to mount`, element !== null && element !== undefined)
  const m = await mountOffscreen(wrap(h(Harness, { columns, element })), columns, rows)
  const painted = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('↑↓ select'), 10000)
  check(`${columns}x${rows}: the picker painted its title and legend`, painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(400)
  return { m, done, columns, rows }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
const popupLines = (m: Mounted): string[] => {
  const lines = m.lines()
  const top = lines.findIndex(l => l.includes(TITLE))
  if (top < 0) return []
  const bottom = lines.findIndex((l, y) => y > top && l.includes('esc or click outside closes'))
  return lines.slice(top, bottom < 0 ? lines.length : bottom + 1)
}
const boxText = (m: Mounted): string => {
  const line = popupLines(m).find(l => /│\s+\/ /.test(l)) ?? ''
  return line.replace(/^.*?│\s+(\/ .*?)\s*│.*$/, '$1').trim()
}
const effortRow = (m: Mounted): string => {
  const line = rowOf(m, 'effort  ')
  const at = line.indexOf('effort  ')
  if (at < 0) return ''
  const end = line.indexOf('│', at)
  return line.slice(at, end < 0 ? line.length : end).trim()
}
const kept = (done: unknown[][]): boolean => done.length === 1 && String(done[0]?.[0] ?? '').startsWith('Kept model as')
async function typeSlowly(m: Mounted, text: string): Promise<void> {
  for (const ch of text) {
    m.push(ch)
    await settle(90)
  }
}

section('§2 the chat picker at 120x40: a typed name searches, saves nothing and launches nothing')
{
  const scene = await openPicker(120, 40)
  const before = JSON.stringify(engineOf())
  const effortBefore = effortRow(scene.m)
  check('the opened picker shows the effort strip with its chord', effortBefore.includes('[') && effortBefore.endsWith('ctrl+e changes it'), effortBefore)
  check('the box at rest invites typing', boxText(scene.m) === '/ type to search by name or id', boxText(scene.m))
  check('the legend names the context chord at this width', rowOf(scene.m, '↑↓ select').includes('ctrl+w context'), rowOf(scene.m, '↑↓ select').trim())
  await typeSlowly(scene.m, 'sonnet')
  const searched = await waitFor(() => boxText(scene.m) === '/ sonnet' && /Mercury · model · \d+ of \d+ match/.test(scene.m.screen()), 6000)
  check('typing sonnet with the rows focused lands in the search box and the title counts the matches', searched, `${boxText(scene.m)} · ${rowOf(scene.m, TITLE).trim()}`)
  check('the picker stays open: no local-model wizard, no server probe', scene.m.screen().includes(TITLE) && !scene.m.screen().includes('localsetup ') && !scene.m.screen().includes('Find a server') && scene.done.length === 0, scene.m.lines().filter(l => /Find a server|Kept model/.test(l)).join(' | '))
  check('only Sonnet rows remain listed', scene.m.screen().includes('claude-sonnet-5-5') && !scene.m.screen().includes('claude-fable-5-1'), popupLines(scene.m).filter(l => l.includes('claude-')).join(' | '))
  check('nothing was saved: the engine settings are as they were', JSON.stringify(engineOf()) === before, `${before} → ${JSON.stringify(engineOf())}`)
  check('the effort bracket did not move on the e in sonnet', effortRow(scene.m) === effortBefore, `${effortBefore} → ${effortRow(scene.m)}`)
  save('typed-sonnet-120x40', scene.m.lines())
  scene.m.push(KEY.esc)
  const cleared = await waitFor(() => boxText(scene.m) === '/ search by name or id' && scene.m.screen().includes(TITLE) && !/ of \d+ match/.test(scene.m.screen()), 6000)
  check('esc clears the search and keeps the picker', cleared, boxText(scene.m))
  scene.m.push(KEY.esc)
  const closed = await waitFor(() => kept(scene.done), 6000)
  check('esc on the empty box closes the picker once, the model kept', closed, JSON.stringify(scene.done))
  await closeScene(scene)
}
{
  const scene = await openPicker(120, 40)
  const before = JSON.stringify(engineOf())
  const effortBefore = effortRow(scene.m)
  await typeSlowly(scene.m, 'claude')
  const typed = await waitFor(() => boxText(scene.m) === '/ claude', 6000)
  check('typing claude from the rows searches: its c and e are letters, not keys', typed && !scene.m.screen().includes('not a toggle') && effortRow(scene.m) === effortBefore && JSON.stringify(engineOf()) === before, `${boxText(scene.m)} · ${effortRow(scene.m)} · ${JSON.stringify(engineOf())}`)
  check('every Anthropic row matches claude', /Mercury · model · 12 of \d+ match/.test(scene.m.screen()), rowOf(scene.m, TITLE).trim())
  scene.m.push(KEY.esc)
  await waitFor(() => !/ of \d+ match/.test(scene.m.screen()), 4000)
  scene.m.push(KEY.esc)
  await waitFor(() => kept(scene.done), 4000)
  await closeScene(scene)
}
{
  const scene = await openPicker(120, 40)
  check('no effort is saved before the chord', engineOf().effort === undefined, JSON.stringify(engineOf()))
  scene.m.push(CTRL_W)
  const contextAnswered = await waitFor(() => popupLines(scene.m).some(l => /ctx · no alternate window/.test(l)), 6000)
  check('ctrl+w is the context key: the focused row answers with its window', contextAnswered, popupLines(scene.m).filter(l => l.includes('ctx')).join(' | '))
  check('ctrl+w typed nothing into the search', boxText(scene.m) === '/ type to search by name or id', boxText(scene.m))
  scene.m.push(CTRL_E)
  const saved = await waitFor(() => engineOf().effort !== undefined, 6000)
  check('ctrl+e changes it the effort and that choice is saved as the default', saved, JSON.stringify(engineOf()))
  check('ctrl+e typed nothing into the search', boxText(scene.m) === '/ type to search by name or id', boxText(scene.m))
  await settle(300)
  save('chords-120x40', scene.m.lines())
  scene.m.push(KEY.esc)
  const closed = await waitFor(() => kept(scene.done), 6000)
  check('esc with no search closes the picker once, the model kept', closed, JSON.stringify(scene.done))
  await closeScene(scene)
}

section('§3 the compact picker at 80x24: the same letters search')
{
  const scene = await openPicker(80, 24)
  const before = JSON.stringify(engineOf())
  await typeSlowly(scene.m, 'opus')
  const searched = await waitFor(() => boxText(scene.m) === '/ opus' && /\d+ of \d+ match/.test(scene.m.screen()), 6000)
  check('typing opus searches at 80x24', searched, `${boxText(scene.m)} · ${rowOf(scene.m, TITLE).trim()}`)
  check('nothing saved, nothing launched', JSON.stringify(engineOf()) === before && !scene.m.screen().includes('localsetup') && scene.done.length === 0)
  save('typed-opus-80x24', scene.m.lines())
  await closeScene(scene)
}

section('§4 /model with words that name no listed model: the words become the picker\'s search, nothing is saved')
{
  const scene = await openPicker(120, 40, 'gpt 6 luna')
  const before = JSON.stringify(engineOf())
  const carried = await waitFor(() => boxText(scene.m) === '/ gpt 6 luna', 6000)
  check('the typed words are the search box\'s text when the picker opens', carried, boxText(scene.m))
  check('the title counts the matches for those words (none in a home with no GPT rows)', /Mercury · model · 0 of \d+ match/.test(scene.m.screen()), rowOf(scene.m, TITLE).trim())
  check('the notice says the words name no listed model', popupLines(scene.m).some(l => l.includes("'gpt 6 luna' names no listed model")), popupLines(scene.m).filter(l => l.includes('listed')).join(' | '))
  check('nothing was saved and nothing launched', JSON.stringify(engineOf()) === before && scene.done.length === 0 && !scene.m.screen().includes('localsetup'), JSON.stringify(engineOf()))
  save('typed-words-gpt-6-luna-120x40', scene.m.lines())
  scene.m.push(KEY.esc)
  const cleared = await waitFor(() => boxText(scene.m) === '/ search by name or id' && scene.m.screen().includes(TITLE), 6000)
  check('esc clears the carried words and keeps the picker open with every row', cleared && !/ of \d+ match/.test(scene.m.screen()), boxText(scene.m))
  scene.m.push(KEY.esc)
  await waitFor(() => kept(scene.done), 6000)
  await closeScene(scene)
}
{
  const scene = await openPicker(120, 40, 'claude 5')
  const carried = await waitFor(() => boxText(scene.m) === '/ claude 5' && /Mercury · model · \d+ of \d+ match/.test(scene.m.screen()), 6000)
  check('words that match rows open the picker filtered to them, the title counting the matches', carried, `${boxText(scene.m)} · ${rowOf(scene.m, TITLE).trim()}`)
  const matched = Number(/Mercury · model · (\d+) of \d+ match/.exec(scene.m.screen())?.[1] ?? '0')
  check('a row of the filtered list is the focused one (boxed)', matched > 0 && popupLines(scene.m).some(l => /│ │ │ .*claude-/.test(l)), popupLines(scene.m).filter(l => l.includes('claude-')).join(' | '))
  save('typed-words-claude-5-120x40', scene.m.lines())
  scene.m.push(KEY.esc)
  await waitFor(() => !/ of \d+ match/.test(scene.m.screen()), 4000)
  scene.m.push(KEY.esc)
  await waitFor(() => kept(scene.done), 4000)
  await closeScene(scene)
}

await releaseScratchHome(HOME)
console.log(`\nmodel picker typed letters: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
