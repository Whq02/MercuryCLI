#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-screen-keys')
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

const LONG_CONTEXT = 'User instruction at session start, stated twice, to be kept word for word with every one of its qualifications and the reason it was given, so that the line on the topic page runs well past the two hundred and forty characters a grep hit used to keep'
const LONG_RULE = 'always spell colour and favourite the British way in anything you write for me'
const SHORT_RULE = 'use tabs not spaces in every file you write for me'
const PLAIN_FACT = 'the staging database for this project is called stagedb7'
const CONVENTION = 'Tests: use zebrafinch only, never the other runner, and never touch the existing tests'

const layout = (await import('../../src/components/memory/memoryCentreLayout.ts')) as Record<string, unknown>
const view = (await import('../../src/components/memory/MemoryCentreView.tsx')) as Record<string, unknown>
const call = <T,>(mod: Record<string, unknown>, name: string, ...args: unknown[]): T | undefined => {
  const fn = mod[name]
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => T)(...args) : undefined
}

section('§0 the layout words: the search scope, the conventions, the file page, the footers per row kind, the facts row')
{
  check('the search placeholder names the instruction files beside the facts and rules', String(layout.MEMORY_SEARCH_PLACEHOLDER) === 'type to search facts, rules and instruction files', String(layout.MEMORY_SEARCH_PLACEHOLDER))
  check('the hint under the matches names what the search reads, the instruction files included', String(layout.MEMORY_SEARCH_READS ?? '').includes('the instruction files'), String(layout.MEMORY_SEARCH_READS))
  const files = [{ path: '/p/MERCURY.md', text: '# Rules\n\n- Tests: run unittest only\n- Never force-push\n\nsome prose about unittest discovery\n' }, { path: '/p/.mercury/guide.md', text: '## Style\n- tabs not spaces\n' }]
  const hits = call<{ file: string; line: number; text: string; path: string }[]>(layout, 'conventionHits', 'unittest', files) ?? []
  check('conventionHits finds every line carrying the word, numbered as the file numbers them, the list marker stripped, headings skipped', hits.length === 2 && hits[0]!.file === 'MERCURY.md' && hits[0]!.line === 3 && hits[0]!.text === 'Tests: run unittest only' && hits[1]!.line === 6, j(hits))
  const two = call<unknown[]>(layout, 'conventionHits', 'tabs spaces', files) ?? []
  check('a two-word query needs both words on the line', two.length === 1 && (two[0] as { file: string }).file === 'guide.md', j(two))
  check('the convention row reads file:line · the line', call<string>(layout, 'conventionRowLabel', hits[0]) === 'MERCURY.md:3 · Tests: run unittest only')
  const page = call<{ text: string; marked?: boolean; kind: string }[]>(layout, 'filePageLines', files[0]!.text, 60, 3) ?? []
  check('the file page keeps the file line by line and marks the hit line, blanks collapsed', page.some(l => l.marked === true && l.text.includes('Tests: run unittest only')) && page.filter(l => l.marked).length === 1 && page[0]!.kind === 'heading' && !page.some((l, i) => l.kind === 'blank' && page[i + 1]?.kind === 'blank'), j(page))
  check('the search line says what typing does where it stands: search on the overview, filter in a list, nothing while a fact is open', call<string>(layout, 'searchPlaceholder', 'overview') === layout.MEMORY_SEARCH_PLACEHOLDER && call<string>(layout, 'searchPlaceholder', 'list') === 'type to filter the list' && call<string>(layout, 'searchPlaceholder', 'open') === 'esc back, then type to search')
  const footer = (state: unknown): string => call<string>(layout, 'memoryFooter', state) ?? ''
  check('a list footer names ↑↓, ↵ open and esc back — never a letter key', footer({ kind: 'list', open: 'open', empty: false }) === '↑↓ move · ↵ open · esc back' && !/\bu unpin\b/.test(footer({ kind: 'list', open: 'open', empty: false })), footer({ kind: 'list', open: 'open', empty: false }))
  check('an empty list draws esc back alone; an empty search draws esc clears the search alone', footer({ kind: 'list', open: 'open', empty: true }) === 'esc back' && footer({ kind: 'search', empty: true }) === 'esc clears the search', `${footer({ kind: 'list', open: 'open', empty: true })} / ${footer({ kind: 'search', empty: true })}`)
  check('a session row without a note offers no ↵', footer({ kind: 'list', open: null, empty: false }) === '↑↓ move · esc back')
  check('an instruction-file page offers e open in editor before the scroll and back keys', footer({ kind: 'page', scrolls: true, editable: true }) === 'e open in editor · ↑↓ scroll · esc back' && footer({ kind: 'page', scrolls: false, editable: false }) === 'esc back')
  const facts = call<{ action: string | null }>(layout, 'factsRow', { enabled: true, entryCount: 3, recent: 0, historyCount: 0, topicCount: 1, newestFact: null })
  const none = call<{ action: string | null }>(layout, 'factsRow', { enabled: true, entryCount: 0, recent: 0, historyCount: 0, topicCount: 0, newestFact: null })
  check('the facts row opens the facts when there are any and offers nothing when there are none', facts?.action === 'list the facts' && none?.action === null, j([facts, none]))
  check('a coalesced chunk lands whole in the search; control characters are dropped', call<string>(view, 'printable', 'ab\u001bc\u007f') === 'abc' && call<string>(view, 'printable', 'user-preferences') === 'user-preferences')
  check('a source reads in plain words', call<string>(view, 'sourceWords', 'tool:Retain s:83fe6475') === 'from the chat' && call<string>(view, 'sourceWords', 'operator') === 'from /memory' && call<string>(view, 'sourceWords', 'handover:notes') === 'taken in from notes')
}

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact, readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { collectMemoryRefs } = await import('../../src/mneme/memoryRefs.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: true } }))
resetSettingsCache()
writeFileSync(join(HOME, 'MERCURY.md'), `# Project conventions\n\n- ${CONVENTION}\n- Commit messages in the imperative\n`)
const dir = mnemeLibraryDir()
appendObservation({ text: `${LONG_RULE}. (context: ${LONG_CONTEXT})`, source: 'tool:Retain s:83fe6475', topicHint: 'writing-style', pin: true, asked: true }, dir)
appendObservation({ text: `${SHORT_RULE}.`, source: 'tool:Retain s:83fe6475', topicHint: 'user-preferences', pin: true, asked: true }, dir)
appendObservation({ text: `${PLAIN_FACT}.`, source: 'tool:Retain s:83fe6475', topicHint: 'general' }, dir)
maybeConsolidate({ force: true, dir })
const docs = listTopicDocs(dir)
const entry = (text: string) => docs.flatMap(d => d.sections.flatMap(s => s.entries)).find(e => e.text.startsWith(text))!
const longSeq = entry(LONG_RULE).seq
const shortSeq = entry(SHORT_RULE).seq
const plainSeq = entry(PLAIN_FACT).seq
if (!readPins(dir).some(p => p.seq === longSeq)) pinFact(longSeq, dir, new Date(), { asked: true })
if (!readPins(dir).some(p => p.seq === shortSeq)) pinFact(shortSeq, dir, new Date(), { asked: true })
maybeConsolidate({ force: true, dir })

section('§1 the search reaches every fact with its seq: a long line keeps its signature, the row shows the words and the pin')
{
  const refs = collectMemoryRefs('colour', { maxRefs: 12, libraryDir: dir })
  const hit = refs.find(r => r.summary.includes('colour'))
  check('the long fact is found under its seq, not as a line pointer', hit !== undefined && hit.refId === `mneme:${longSeq}`, j(refs.map(r => r.refId)))
  check('its summary is the fact\'s words — no markdown dash, no signature', hit !== undefined && hit.summary.startsWith(LONG_RULE) && !hit.summary.startsWith('-'), hit?.summary ?? '')
  check('its time and source ride along', hit?.capturedAt !== undefined && hit?.source === 'tool:Retain s:83fe6475', j(hit))
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
const rowsOf = (m: Mounted, needle: string): string[] => m.lines().filter(l => l.includes(needle))
const footerOf = (m: Mounted): string => m.lines().findLast(l => (l.includes('esc back') || l.includes('esc clears the search') || l.includes(String(layout.MEMORY_CLOSE_HINT)) || l.includes('esc cancel')) && !l.includes('/ esc back')) ?? ''
const home = async (m: Mounted): Promise<void> => {
  for (let step = 0; step < 12; step++) m.push(KEY.up)
  await settle(80)
}
async function moveTo(m: Mounted, needle: string): Promise<string> {
  for (let step = 0; step < 16 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}
type Scene = { m: Mounted; done: unknown[][]; columns: number; rows: number }
async function openMemory(columns: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(100)
  const done: unknown[][] = []
  const element = await memoryCommand.call((...c: unknown[]) => { done.push(c) }, { messages: [], options: {} } as never, '')
  check(`${columns}x${rows}: /memory opens the popup`, element === null && settingsStore.isSettingsPopupOpen() && settingsStore.settingsPopupRequest()?.view === 'memory')
  const painted = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('section'), 8000)
  check(`${columns}x${rows}: the popup painted`, painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(250)
  return { m, done, columns, rows }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}
const type = async (m: Mounted, text: string): Promise<void> => {
  for (const ch of text) m.push(ch)
  await settle(120)
}

section('§2 the opened fact is one view with its keys, whatever list or search it came from (120x40)')
{
  const scene = await openMemory(120, 40)
  const { m } = scene
  await type(m, 'colour')
  const found = await waitFor(() => m.screen().includes('matches for “colour”') && m.screen().includes(LONG_RULE.slice(0, 30)), 6000)
  check('the search finds the long rule', found, rowOf(m, 'matches for'))
  const row = rowOf(m, LONG_RULE.slice(0, 30))
  check('the match row carries the pin mark and the words, no markdown dash', row.includes('pinned · ') && !/●\s+-\s/.test(row), row.trim())
  check('the hint under the matches names the fact in plain words: when it was saved and from where', rowsOf(m, 'from the chat').length >= 1 && !m.screen().includes('tool:Retain') && !m.screen().includes('s:83fe6475'), m.lines().filter(l => l.includes('matches') || l.includes('saved')).join(' | '))
  save('search-colour-120x40', m.lines())
  m.push(KEY.enter)
  const opened = await waitFor(() => m.screen().includes(`seq ${longSeq}`) && footerOf(m).includes('c correct'), 6000)
  check('↵ opens the fact found by the search with c correct · x retire · u unpin, like any other', opened && footerOf(m).includes('c correct · x retire · u unpin · esc back'), footerOf(m))
  check('the header reads seq, pinned and asked for by you — no internal id', rowOf(m, `seq ${longSeq}`).includes('pinned · asked for by you') && !m.screen().includes('mneme:'), rowOf(m, `seq ${longSeq}`).trim())
  check('the why line reads in plain words', rowsOf(m, 'from the chat').length >= 1 && !m.screen().includes('tool:Retain'), m.lines().filter(l => l.includes('pinned ') && l.includes('saved')).join(' | '))
  check('the search line keeps the standing query while the fact is open', rowOf(m, '/ colour') !== '', rowOf(m, '/ ').trim())
  save('fact-open-120x40', m.lines())
  m.push('u')
  const unpinned = await waitFor(() => !readPins(dir).some(p => p.seq === longSeq) && m.screen().includes('unpinned'), 8000)
  check('u unpins at once and the line offers the way back: p pins it again, and says the open chat keeps what it loaded', unpinned && rowOf(m, 'unpinned').includes('p pins it again') && rowOf(m, 'unpinned').includes('this chat keeps what it loaded'), rowOf(m, 'unpinned').trim())
  await waitFor(() => footerOf(m).includes('p pin'), 6000)
  check('the footer now offers p pin in place of u unpin', footerOf(m).includes('c correct · x retire · p pin · esc back'), footerOf(m))
  save('fact-unpinned-120x40', m.lines())
  m.push('p')
  const repinned = await waitFor(() => readPins(dir).some(p => p.seq === longSeq && p.asked === true) && m.screen().includes('u unpins it again'), 8000)
  check('p pins it again, asked for by you, and the line offers u', repinned, rowOf(m, 'pinned word for word').trim())
  await waitFor(() => footerOf(m).includes('u unpin'), 6000)
  m.push('x')
  const armed = await waitFor(() => m.screen().includes(`retire seq ${longSeq}? x again retires it`), 6000)
  check('x asks first, in one line: x again retires it, any other key keeps it', armed && rowOf(m, 'x again retires it').includes('any other key keeps it'), rowOf(m, 'retire seq').trim())
  save('fact-retire-asked-120x40', m.lines())
  m.push('a')
  const kept = await waitFor(() => m.screen().includes(`kept seq ${longSeq} — nothing changed`), 6000)
  check('another key keeps it and says so; the fact is still live', kept && listTopicDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries)).some(e => e.seq === longSeq), rowOf(m, 'kept seq').trim())
  m.push('x')
  await waitFor(() => m.screen().includes('x again retires it'), 6000)
  m.push('x')
  const retired = await waitFor(() => m.screen().includes(`retired seq ${longSeq}`), 8000)
  check('x twice retires it — kept in history — and the receipt says the open chat keeps what it loaded', retired && rowOf(m, 'retired seq').includes('this chat keeps what it loaded'), rowOf(m, 'retired seq').trim())
  check('on disk: the fact is history, no longer live', listTopicDocs(dir).some(d => d.history.some(e => e.seq === longSeq)) && !listTopicDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries)).some(e => e.seq === longSeq))
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await settle(150)
  check('esc clears the search and lands on the overview', m.screen().includes('facts and decisions') && !m.screen().includes('matches for'))

  section('§3 the instruction files are in the search: a convention opens as its file at the line, e opens the editor (120x40)')
  await type(m, 'zebrafinch')
  const conv = await waitFor(() => m.screen().includes('MERCURY.md:3 ·'), 6000)
  check('the convention stated in MERCURY.md is found by its own word, as file:line · the line', conv && rowOf(m, 'MERCURY.md:3').includes('Tests: use zebrafinch only'), m.lines().filter(l => l.includes('MERCURY') || l.includes('matches')).join(' | '))
  check('the hint says what it is and where: instruction file, the line, loads every session', rowsOf(m, 'instruction file ·').some(l => l.includes('line 3') && l.includes('loads every session')), m.lines().filter(l => l.includes('instruction file') || l.includes('loads every')).join(' | '))
  save('search-convention-120x40', m.lines())
  m.push(KEY.enter)
  const filePage = await waitFor(() => m.screen().includes('memory › instruction files › MERCURY.md') && m.screen().includes('Commit messages in the imperative'), 6000)
  check('↵ opens the file as a page', filePage, m.lines().filter(l => l.includes('›')).join(' | '))
  check('the matched line is the marked one', rowsOf(m, 'Tests: use zebrafinch only').some(l => l.includes('❯')) && !rowsOf(m, 'Commit messages').some(l => l.includes('❯')), rowsOf(m, 'zebrafinch').join(' | '))
  check('the meta names the line, that it loads every session, and the file', rowOf(m, 'line 3 · loads every session · ') !== '', m.lines().filter(l => l.includes('line 3')).join(' | '))
  check('the footer offers e open in editor and esc back', footerOf(m).includes('e open in editor') && footerOf(m).endsWith('esc back') || footerOf(m).includes('e open in editor · esc back'), footerOf(m))
  save('convention-page-120x40', m.lines())
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('matches for “zebrafinch”'), 6000)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)

  section('§4 no letter acts in a list: typing filters the pinned rules and never unpins one; the footer draws no letter key (120x40)')
  await moveTo(m, 'pinned rules')
  m.push(KEY.enter)
  await waitFor(() => m.screen().includes('memory › pinned rules'), 6000)
  await settle(150)
  check('the pinned list footer names ↑↓, ↵ open and esc back and no letter', footerOf(m) === rowOf(m, '↵ open · esc back') && !footerOf(m).includes('u unpin') && footerOf(m).includes('↵ open'), footerOf(m))
  check('the search line says it filters the list', m.screen().includes('type to filter the list'))
  const pinsBefore = readPins(dir).length
  await type(m, 'fo')
  await waitFor(() => rowOf(m, '/ fo') !== '', 4000)
  m.push('u')
  const filtered = await waitFor(() => rowOf(m, '/ fou') !== '', 4000)
  await settle(300)
  check('u after fo extends the filter to fou', filtered, rowOf(m, '/ ').trim())
  check('no rule was unpinned', readPins(dir).length === pinsBefore && !m.screen().includes('unpinned'), `${pinsBefore} → ${readPins(dir).length}`)
  save('pinned-filter-fou-120x40', m.lines())
  m.push(KEY.esc)
  await waitFor(() => !m.screen().includes('/ fou'), 4000)
  m.push('u')
  await settle(300)
  check('u on an empty filter is a filter letter too — the rule stays pinned', rowOf(m, '/ u') !== '' && readPins(dir).length === pinsBefore, rowOf(m, '/ ').trim())
  m.push(KEY.esc)
  await settle(100)
  m.push(KEY.enter)
  const ruleOpen = await waitFor(() => footerOf(m).includes('u unpin'), 6000)
  check('↵ opens the rule, where u unpin is drawn', ruleOpen && footerOf(m).includes('c correct · x retire · u unpin'), footerOf(m))
  check('the search line says typing does nothing while the rule is open', m.screen().includes('/ esc back, then type to search'), rowOf(m, '/ ').trim())
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('memory › pinned rules'), 6000)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)

  section('§5 the facts row opens the facts; / focuses the search; a multi-character chunk lands whole; esc returns to the row (120x40)')
  await settle(150)
  check('esc from the pinned list returned to the pinned rules row', rowOf(m, 'pinned rules').includes('❯'), rowOf(m, 'pinned rules').trim())
  await home(m)
  check('the facts row footer offers ↵ list the facts', rowOf(m, String(layout.MEMORY_CLOSE_HINT)).includes('↵ list the facts'), rowOf(m, String(layout.MEMORY_CLOSE_HINT)))
  m.push(KEY.enter)
  const factsList = await waitFor(() => m.screen().includes('memory › facts and decisions') && m.screen().includes(PLAIN_FACT.slice(0, 30)), 6000)
  check('↵ lists the facts newest first with their dates and the pin mark', factsList && /\d\d [A-Z][a-z]{2} \d\d:\d\d  /.test(rowOf(m, PLAIN_FACT.slice(0, 30))) && rowOf(m, SHORT_RULE.slice(0, 20)).includes('pinned · '), m.lines().filter(l => l.includes('❯') || l.includes('pinned ·')).join(' | '))
  save('facts-list-120x40', m.lines())
  await moveTo(m, PLAIN_FACT.slice(0, 30))
  m.push(KEY.enter)
  const plainOpen = await waitFor(() => m.screen().includes(`seq ${plainSeq}`) && footerOf(m).includes('p pin'), 6000)
  check('a plain fact opens with c correct · x retire · p pin — every fact is reachable and actionable', plainOpen && footerOf(m).includes('c correct · x retire · p pin · esc back'), footerOf(m))
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('memory › facts and decisions'), 6000)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await settle(150)
  check('esc from the facts list returns to the facts row', rowOf(m, 'facts and decisions').includes('❯'), rowOf(m, 'facts and decisions').trim())
  await moveTo(m, 'lineage')
  m.push(KEY.enter)
  await waitFor(() => m.screen().includes('memory › lineage'), 6000)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await settle(150)
  check('esc from the lineage returns to the lineage row, not the first', rowOf(m, 'lineage').includes('❯') && !rowOf(m, 'facts and decisions').includes('❯'), rowOf(m, 'lineage').trim())
  check('the detail slot describes the selected row, not a stale receipt', (rowsOf(m, 'before this one').length >= 1 || rowsOf(m, 'first session of this work').length >= 1) && !m.screen().includes('retired seq') && !m.screen().includes('unpinned'), m.lines().filter(l => l.includes('first session') || l.includes('before this one') || l.includes('retired')).join(' | '))
  save('esc-returns-to-row-120x40', m.lines())
  const searchY = m.lines().findIndex(line => line.includes(`/ ${layout.MEMORY_SEARCH_PLACEHOLDER}`))
  const searchX = (m.lines()[searchY] ?? '').indexOf('/ ')
  const unfocused = m.styleAt(searchX, searchY)?.fg
  m.push('/')
  const searchRow = (): string => m.lines()[searchY] ?? ''
  const focused = await waitFor(() => {
    const fg = m.styleAt(searchX, searchY)?.fg
    const row = searchRow()
    return unfocused !== undefined && fg !== undefined && fg !== unfocused && row.includes(`/ ${layout.MEMORY_SEARCH_PLACEHOLDER}`) && !row.includes('/ /')
  }, 4000)
  check('/ focuses the search and is not its first character', focused, searchRow().trim())
  m.push('tab')
  const chunk = await waitFor(() => rowOf(m, '/ tab') !== '' && m.screen().includes('matches for “tab”'), 6000)
  check('a three-character chunk lands whole in the search', chunk, rowOf(m, '/ ').trim())
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  const filesRow = (): string => m.lines().find(l => /instruction files\s+\d+ files?\s/.test(l)) ?? ''
  for (let step = 0; step < 14 && !filesRow().includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  m.push(KEY.enter)
  const picker = await waitFor(() => m.screen().includes('Memory: on') && m.screen().includes('profile auto:'), 8000)
  check('↵ on instruction files opens the picker', picker)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await settle(200)
  check('esc from the picker returns to the instruction files row, not the first', filesRow().includes('❯') && !rowOf(m, 'facts and decisions').includes('❯'), filesRow().trim())
  await type(m, 'qqqzzxw')
  const emptySearch = await waitFor(() => m.screen().includes('nothing matches'), 6000)
  check('a search with no match says so and its footer is esc clears the search alone — no ↑↓, no ↵', emptySearch && footerOf(m).includes('esc clears the search') && !footerOf(m).includes('↵') && !footerOf(m).includes('↑↓'), footerOf(m))
  save('empty-search-120x40', m.lines())
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await closeScene(scene)
}

section('§6 the opened fact and the convention page at 80x24 and 100x30')
for (const [columns, rows] of [[80, 24], [100, 30]] as const) {
  const scene = await openMemory(columns, rows)
  const { m } = scene
  await type(m, 'tabs')
  await waitFor(() => m.screen().includes(SHORT_RULE.slice(0, 20)), 6000)
  m.push(KEY.enter)
  const opened = await waitFor(() => m.screen().includes(`seq ${shortSeq}`) && footerOf(m).includes('c correct · x retire · u unpin'), 6000)
  check(`${columns}x${rows}: the fact found by the search opens with its keys`, opened, footerOf(m))
  check(`${columns}x${rows}: no painted row is wider than the terminal`, m.lines().every(l => Array.from(l).length <= columns))
  save(`fact-open-${columns}x${rows}`, m.lines())
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('matches for'), 6000)
  m.push(KEY.esc)
  await waitFor(() => m.screen().includes('section'), 6000)
  await type(m, 'zebrafinch')
  await waitFor(() => m.screen().includes('MERCURY.md:3'), 6000)
  m.push(KEY.enter)
  const page = await waitFor(() => m.screen().includes('instruction files › MERCURY.md') && rowsOf(m, 'zebrafinch').some(l => l.includes('❯')), 6000)
  check(`${columns}x${rows}: the convention opens as its file at the marked line`, page, m.lines().filter(l => l.includes('zebrafinch')).join(' | '))
  save(`convention-page-${columns}x${rows}`, m.lines())
  await closeScene(scene)
}

await releaseScratchHome(HOME)
console.log(`\nmemory screen keys: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
