#!/usr/bin/env bun
// gate-watch: src/commands/memory/memory.tsx src/components/memory/MemoryCentreView.tsx src/components/memory/memoryCentreLayout.ts src/mneme/mnemeCorrect.ts src/mneme/memoryVerbs.ts src/mneme/mnemeConsolidate.ts src/tools/MemoryTools/prompt.ts src/tools/MemoryTools/MemoryTools.ts docs/MNEME.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-rule-edit-road')
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
function section(title: string): void {
  console.log(`\n${title}`)
}
const save = (name: string, lines: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}
const j = (v: unknown): string => JSON.stringify(v)

const OLD_RULE = 'I like short answers - tell me what you did in three lines, no essays'
const NEW_RULE = 'I want five-line answers, not three'
const RESTATED = 'give me long, detailed answers from now on'

const layout = await import('../../src/components/memory/memoryCentreLayout.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))

const { retainItems, correctMemory, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { readFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')
const { USER_ASKED_RULE_ROAD } = await import('../../src/mneme/mnemeCorrect.ts')
const { RETAIN_PROMPT, CORRECT_PROMPT } = await import('../../src/tools/MemoryTools/prompt.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
resetSettingsCache()
const dir = mnemeLibraryDir()

section('§0 the words every road reads: the legend, the refusal, the prompts and the manual name the edit key')
check('the pinned list legend names the road: ↵ opens a rule, c corrects it, x retires it, u unpins it', /↵ opens a rule: c corrects it, x retires it, u unpins it/.test(layout.VIEW_LEGEND.pinned), layout.VIEW_LEGEND.pinned)
check('the model-facing refusal names the key, not just the screen', /c corrects it/.test(USER_ASKED_RULE_ROAD) && /\/memory/.test(USER_ASKED_RULE_ROAD) && /u unpins it/.test(USER_ASKED_RULE_ROAD), USER_ASKED_RULE_ROAD)
check('the Retain prompt tells the model the road and that a restated rule replaces the unpinned one', /↵ opens the rule and c corrects it/.test(RETAIN_PROMPT) && /unpinned/.test(RETAIN_PROMPT) && /ONE rule stays current/.test(RETAIN_PROMPT))
check('the Correct prompt tells the model the road', /↵ opens the rule and c corrects it/.test(CORRECT_PROMPT))
const manual = readFileSync(join(REPO, 'docs/MNEME.md'), 'utf8')
check('the manual says how a rule you asked for is changed', manual.includes('`↵` opens the rule and `c` corrects it') && manual.includes('the pin and its "asked for'), manual.split('\n').find(l => l.includes('corrects it')) ?? '')

const ownerSaid = (text: string) => ({ messageId: `owner-${text.length}`, text })
const seeded = retainItems([{ content: OLD_RULE, pin: true, topic: 'user-preferences' }], { session: 'edit-road-seed', pinIntent: ownerSaid(`Remember this as a standing rule: ${OLD_RULE}`) }, dir)
_resetMemoryVerbSessionStateForTesting()
check('seed: the rule the user asked for is staged pinned', seeded[0]?.status === 'stored', j(seeded))
check('seed: consolidation puts it on the shelf', maybeConsolidate({ force: true, dir }).consolidated)
const prefs = (): ReturnType<typeof listTopicDocs>[number] => listTopicDocs(dir).find(d => d.slug === 'user-preferences')!
const oldSeq = prefs().sections[0]!.entries[0]!.seq
check('seed: pinned and marked asked for by the user', readPins(dir).some(p => p.seq === oldSeq && p.asked === true), j(readPins(dir)))

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
const memoryCommand = await import('../../src/commands/memory/memory.tsx')

function Harness({ columns }: { columns: number }): React.ReactNode {
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 100 }, (_, index) => h(Text, { key: index, wrap: 'truncate-end' }, 'T'.repeat(columns)))),
    statusBand: h(Text, null, 'live transcript behind the popup'),
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
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))
const TITLE = 'Mercury · memory'
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
async function moveTo(m: Mounted, needle: string): Promise<string> {
  for (let step = 0; step < 14 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}
type Scene = { m: Mounted; done: unknown[][] }
async function openMemory(columns: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(100)
  const done: unknown[][] = []
  const element = await memoryCommand.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, '')
  check(`${columns}x${rows}: /memory opens the popup`, element === null && settingsStore.isSettingsPopupOpen() && settingsStore.settingsPopupRequest()?.view === 'memory')
  const painted = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('section'), 8000)
  check(`${columns}x${rows}: the popup painted`, painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(250)
  return { m, done }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}

section('§1 the road on the screen (120x40): pinned rules → ↵ on the rule → c → retype → ↵; the pin and the asked mark follow; the old wording is history')
{
  const scene = await openMemory(120, 40)
  await moveTo(scene.m, 'pinned rules')
  scene.m.push(KEY.enter)
  const listed = await waitFor(() => scene.m.screen().includes('memory › pinned rules') && scene.m.screen().includes('asked for by you'), 6000)
  check('↵ on the pinned row lists the rule the user asked for', listed, rowOf(scene.m, 'memory ›'))
  await settle(150)
  save('edit-road-1-pinned-list', scene.m.lines())
  check('the list legend on the screen names the road: ↵ opens a rule, c corrects it', scene.m.lines().some(l => l.includes('↵ opens a rule: c corrects it')), scene.m.lines().filter(l => l.includes('opens a rule') || l.includes('unpins it')).join(' | '))
  check('the footer offers ↵ open', scene.m.lines().some(l => l.includes('↵ open')), rowOf(scene.m, 'esc back'))
  scene.m.push(KEY.enter)
  const opened = await waitFor(() => /seq \d+ · pinned · asked for by you/.test(scene.m.screen()) && scene.m.screen().includes('c correct · x retire · u unpin'), 6000)
  check('↵ opens the rule with its three keys beside each other in the footer: c correct · x retire · u unpin', opened, scene.m.lines().filter(l => l.includes('correct') || l.includes('asked for by you')).join(' | '))
  await settle(120)
  save('edit-road-2-rule-open', scene.m.lines())
  scene.m.push('c')
  const correcting = await waitFor(() => scene.m.screen().includes(`correcting seq ${oldSeq}`), 6000)
  check('c opens the correction box for the rule', correcting, scene.m.lines().filter(l => l.includes('correcting')).join(' | '))
  await settle(120)
  save('edit-road-3-correcting', scene.m.lines())
  check('the correction screen shows the wording being replaced, so the user retypes with it in view', scene.m.lines().some(l => l.includes('now: I like short answers')), scene.m.lines().filter(l => l.includes('now:') || l.includes('correcting')).join(' | '))
  check('the correction screen says the old wording goes to history and the pin and its asked-for mark follow the new one', scene.m.lines().some(l => l.includes('the wording below goes to history')) && scene.m.lines().some(l => l.includes('the pin and its asked-for mark follow the new wording')), scene.m.lines().filter(l => l.includes('history') || l.includes('asked-for')).join(' | '))
  check('the footer offers ↵ save correction · esc cancel', scene.m.lines().some(l => l.includes('↵ save correction') && l.includes('esc cancel')))
  for (const ch of NEW_RULE) scene.m.push(ch)
  const typed = await waitFor(() => scene.m.screen().includes(`> ${NEW_RULE}`), 6000)
  check('the typed rule shows in the box', typed, rowOf(scene.m, '> '))
  save('edit-road-4-typed', scene.m.lines())
  scene.m.push(KEY.enter)
  const saved = await waitFor(() => scene.m.screen().includes('corrected seq'), 8000)
  check('↵ saves: the note says corrected seq N → M (old kept as history)', saved && new RegExp(`corrected seq ${oldSeq} → \\d+ \\(old kept as history\\)`).test(scene.m.screen()), scene.m.lines().filter(l => l.includes('corrected')).join(' | '))
  await settle(200)
  save('edit-road-5-saved', scene.m.lines())
  const newSeq = prefs().sections.flatMap(s => s.entries).find(e => e.text === NEW_RULE)?.seq ?? -1
  check('on disk: the new wording is the live fact and it supersedes the old seq', newSeq > oldSeq && prefs().sections.flatMap(s => s.entries).some(e => e.seq === newSeq && e.supersedes === String(oldSeq)), j(prefs().sections.flatMap(s => s.entries)))
  check('on disk: the old wording is history, linked to the new one', prefs().history.some(e => e.seq === oldSeq && e.supersededBy === newSeq && e.text === OLD_RULE), j(prefs().history))
  check('on disk: ONE current rule in the topic', prefs().sections.flatMap(s => s.entries).length === 1)
  check('the pin and the asked mark followed the new wording; the old seq is unpinned', readPins(dir).some(p => p.seq === newSeq && p.asked === true) && !readPins(dir).some(p => p.seq === oldSeq), j(readPins(dir)))
  check('the front page lists the new rule behind the asked-pin grade as asked for by the user and not the old one', (readFrontPage(dir) ?? '').includes(`- [pinned · asked by the owner] ${NEW_RULE} <seq=${newSeq}, asked for by the user>`) && !(readFrontPage(dir) ?? '').includes(OLD_RULE), (readFrontPage(dir) ?? '').split('## Pinned')[1] ?? '')
  const relisted = scene.m.lines().filter(l => /chars · asked for by you · /.test(l))
  check('back in the list: one rule row, the new wording, still marked asked for by you', relisted.length === 1 && relisted[0]!.includes(NEW_RULE), relisted.join(' | '))
  await closeScene(scene)

  section('§2 the model\'s Correct on the asked-for rule is refused and names the road')
  const refused = correctMemory({ op: 'supersede', id: `seq:${newSeq}`, content: 'answer in one line', reason: 'the model prefers it', session: 'edit-road-model' }, dir)
  check('refused with the user-asked-rule code', refused.ok === false && refused.code === 'user-asked-rule', j(refused))
  check('the refusal says where and which key: /memory, pinned rules, ↵ opens the rule, c corrects it, u unpins it', refused.ok === false && refused.message.includes('/memory') && /↵ opens the rule: c corrects it/.test(refused.message) && /u unpins it/.test(refused.message), refused.ok === false ? refused.message : '')
  const replaced = retainItems([{ content: 'answer in one line', pin: true, replaces: `seq:${newSeq}` }], { session: 'edit-road-model' }, dir)
  _resetMemoryVerbSessionStateForTesting()
  check('Retain with replaces on the asked-for rule is refused the same way', replaced[0]?.status === 'refused' && replaced[0].reason.includes('only the user changes it') && /c corrects it/.test(replaced[0].reason), j(replaced))
  check('nothing moved on disk', prefs().sections.flatMap(s => s.entries).length === 1 && readPins(dir).some(p => p.seq === newSeq && p.asked === true))

  section('§3 the other road the field took — unpin in /memory, restate in the chat — leaves ONE current rule')
  const again = await openMemory(120, 40)
  await moveTo(again.m, 'pinned rules')
  again.m.push(KEY.enter)
  await waitFor(() => again.m.screen().includes('memory › pinned rules') && again.m.screen().includes(NEW_RULE), 6000)
  again.m.push(KEY.enter)
  await waitFor(() => again.m.screen().includes('c correct'), 6000)
  again.m.push('u')
  const unpinned = await waitFor(() => readPins(dir).length === 0, 8000)
  check('u on the opened rule unpins it', unpinned, j(readPins(dir)))
  await waitFor(() => again.m.screen().includes('unpinned'), 8000)
  await settle(150)
  save('edit-road-6-unpinned', again.m.lines())
  check('the unpinned rule is a plain live fact, still current', prefs().sections.flatMap(s => s.entries).some(e => e.seq === newSeq), j(prefs().sections.flatMap(s => s.entries)))
  await closeScene(again)
  const restated = retainItems([{ content: RESTATED, pin: true, replaces: `seq:${newSeq}` }], { session: 'edit-road-user', pinIntent: ownerSaid(`Remember this as a rule: ${RESTATED}`) }, dir)
  _resetMemoryVerbSessionStateForTesting()
  check('the user restates the rule in the chat and the model names the unpinned one it replaces: stored', restated[0]?.status === 'stored', j(restated))
  check('the pinned retain consolidates at once', maybeConsolidate({ force: true, dir }).consolidated)
  const finalLive = prefs().sections.flatMap(s => s.entries)
  const restatedSeq = finalLive.find(e => e.text === RESTATED)?.seq ?? -1
  check('ONE current rule: the restated one; the unpinned wording is history under it', finalLive.length === 1 && restatedSeq > newSeq && prefs().history.some(e => e.seq === newSeq && e.supersededBy === restatedSeq), j({ live: finalLive.map(e => e.text), history: prefs().history.map(e => [e.seq, e.supersededBy]) }))
  check('the restated rule is pinned and marked asked for by the user', readPins(dir).length === 1 && readPins(dir)[0]!.seq === restatedSeq && readPins(dir)[0]!.asked === true, j(readPins(dir)))
  check('the front page carries the one rule behind the asked-pin grade', (readFrontPage(dir) ?? '').includes(`- [pinned · asked by the owner] ${RESTATED} <seq=${restatedSeq}, asked for by the user>`) && !(readFrontPage(dir) ?? '').includes(NEW_RULE), (readFrontPage(dir) ?? '').split('## Pinned')[1] ?? '')
}

await releaseScratchHome(HOME)
console.log(`\nmemory rule edit road: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
