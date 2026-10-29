#!/usr/bin/env bun
// gate-watch: src/commands/memory/memory.tsx src/components/memory/MemoryCentreView.tsx src/components/memory/memoryCentreLayout.ts
// gate-watch: src/components/Settings/Settings.tsx src/components/SettingsPopupSlot.tsx src/utils/cockpit/settingsPopup.ts src/components/FullscreenLayout.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-centre-popup')
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
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const save = (name: string, lines: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}

const layout = await import('../../src/components/memory/memoryCentreLayout.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))

section('§1 the layout words: human dates, the overview cells, the lineage rows, the page lines, the footers')
{
  const stamp = layout.humanStamp('2026-10-11T01:13:00.000Z')
  const local = new Date('2026-10-11T01:13:00.000Z')
  check('a date reads as day, month and time in the local clock', stamp === `${String(local.getDate()).padStart(2, '0')} Oct ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`, stamp)
  check('no date reads as a dash, a broken one as its own first 16 characters', layout.humanStamp(null) === '—' && layout.humanStamp('not-a-date') === 'not-a-date')
  const ledger = [
    { ordinal: 1, sessionId: 'a', startedAt: '2026-10-10T10:00:00.000Z', endedAt: '2026-10-10T11:00:00.000Z', engines: [{ model: 'claude-fable-5-1', at: '2026-10-10T10:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: 'closed', handoff: { text: 'the first note', at: '2026-10-10T11:00:00.000Z' } },
    { ordinal: 2, sessionId: 'b', startedAt: '2026-10-10T12:00:00.000Z', endedAt: null, engines: [{ model: 'gpt-6-astra', at: '2026-10-10T12:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: null, handoff: null },
    { ordinal: 3, sessionId: 'me', startedAt: '2026-10-11T01:00:00.000Z', endedAt: null, engines: [{ model: 'claude-fable-5-1', at: '2026-10-11T01:00:00.000Z' }], rulings: [], retained: [], corrected: [], files: [], outcome: null, handoff: null },
  ]
  const rows = layout.overviewRows({
    enabled: true, entryCount: 12, recent: 2, historyCount: 3, topicCount: 4, newestFact: '2026-10-11T01:13:00.000Z',
    pinned: { pinned: 1, used: 300, limit: 8000, over: false }, pinnedLimit: 8000, newestPin: '2026-10-10T20:00:00.000Z', newestTopic: '2026-10-11T01:13:00.000Z',
    ledger, sessionId: 'me',
    journal: { enabled: true, entries: [{ at: '2026-10-11T02:15:00.000Z', text: 'one' }, { at: '2026-10-11T03:40:00.000Z', text: 'two' }] },
    intake: { kind: 'due' },
    maintenance: { due: true, dueReason: '2 rows waiting', running: false, degraded: [], lastConsolidatedAt: '2026-10-11T01:13:00.000Z', receipts: [{ ts: '2026-10-11T01:13:00.000Z', trigger: 'operator', ran: true, reason: 'consolidated', entries: 3 }] },
    files: { count: 2, profile: 'auto' },
  })
  check('one row per section, in the order facts · pinned · topics · lineage · journal · notes to take in · maintenance · instruction files', rows.map(r => r.section).join(' · ') === 'facts and decisions · pinned rules · topics · lineage · journal · notes to take in · maintenance · instruction files', rows.map(r => r.section).join(' · '))
  const cell = (id: string) => rows.find(r => r.id === id)!
  check('the facts row counts current and recent, dates the newest fact, reads on and opens the facts', cell('facts').count === '12 current · 2 recent' && cell('facts').newest === stamp && cell('facts').state === 'on' && cell('facts').action === 'list the facts', JSON.stringify(cell('facts')))
  check('the pinned row carries the count and the fill, reads loaded and offers the list', cell('pinned').count === '1 · 300 of 8k' && cell('pinned').state === 'loaded' && cell('pinned').action === 'list the rules', JSON.stringify(cell('pinned')))
  check('the lineage row names the ordinal and the count, the state says whether the last session left a note', cell('lineage').count === 'session 3 · 2 before' && cell('lineage').state === 'no note' && cell('lineage').detail.includes('last note from session 1'), JSON.stringify(cell('lineage')))
  check('the journal row counts the entries, dates the newest and reads on', cell('journal').count === '2 entries' && cell('journal').newest === layout.humanStamp('2026-10-11T03:40:00.000Z') && cell('journal').state === 'on' && cell('journal').action === 'read the entries', JSON.stringify(cell('journal')))
  check('maintenance reads due with the reason in its detail, counts its runs and offers run now', cell('maintenance').state === 'due' && cell('maintenance').count === '1 run' && cell('maintenance').detail.startsWith('due — 2 rows waiting') && cell('maintenance').action === 'run now', JSON.stringify(cell('maintenance')))
  check('the instruction files row counts the files and reads the profile as its state', cell('files').count === '2 files' && cell('files').state === 'auto' && cell('files').action === 'open the picker', JSON.stringify(cell('files')))
  check('the one-word states are one word each, save the honest "no note"', rows.every(r => r.state === 'no note' || !/\s/.test(r.state)), rows.map(r => r.state).join(' · '))
  const off = layout.overviewRows({ enabled: false, entryCount: 0, recent: 0, historyCount: 0, topicCount: 0, newestFact: null, pinned: null, pinnedLimit: 8000, newestPin: null, newestTopic: null, ledger: [], sessionId: 'me', journal: { enabled: false, entries: [] }, intake: null, maintenance: { due: false, dueReason: null, running: false, degraded: [], lastConsolidatedAt: null, receipts: [] }, files: { count: 1, profile: 'native' } })
  check('memory off: the facts row reads off and names the setting; only the instruction files row stays beside it', off.length === 2 && off[0]!.state === 'off' && off[0]!.detail.includes('memory.enabled') && off[1]!.id === 'files' && off[1]!.state === 'native', JSON.stringify(off.map(r => [r.id, r.state])))
  const over = layout.pinnedRow({ pinned: 23, used: 60200, limit: 8000, over: true }, 8000, '2026-10-11T00:00:00.000Z')
  check('a shelf over its limit reads over, all still loaded, with the fill', over.state === 'over' && over.count === '23 · 60k of 8k' && over.detail.includes('all still loaded'), JSON.stringify(over))
  const sessions = layout.lineageRows(ledger, 'me')
  check('the lineage table lists the sessions newest first with the engine, the dates, the open end and the note column', sessions.map(s => s.cells[0]).join(' · ') === '3 (this) · 2 · 1' && sessions[0]!.cells[3] === 'open' && sessions[1]!.cells[3] === 'unclosed' && sessions[2]!.cells[4] === 'yes' && sessions[1]!.cells[4] === 'no' && sessions[1]!.cells[1] === 'gpt-6-astra', JSON.stringify(sessions.map(s => s.cells)))
  const widths = layout.overviewWidths(74)
  const header = layout.tableLine([...layout.OVERVIEW_COLUMNS], widths)
  const row = layout.tableLine(layout.overviewCells(cell('lineage')), widths)
  check('the table line pads every cell to its column so the header and the rows align', header.indexOf('count') === row.indexOf('session 3') && header.indexOf('newest') === row.indexOf(cell('lineage').newest) && header.indexOf('state') === row.indexOf('no note'), `${header}\n${row}`)
  check('the columns fit the narrowest frame (74 inner columns at an 80-column terminal)', widths.reduce((a, b) => a + b, 0) + widths.length - 1 + 2 <= 74, String(widths))
  const page = layout.pageLines('# Lineage\nSession 3 of this work.\n\n- a long item that wraps past the width of the page because it keeps going and going\n## The last note\nword '.repeat(1) + 'word '.repeat(30).trim(), 40)
  check('a page renders headings, paragraphs and items wrapped to the width, blank lines collapsed', page[0]!.kind === 'heading' && page[0]!.text === 'Lineage' && page[1]!.kind === 'text' && page.some(l => l.kind === 'item' && l.text.startsWith('• ')) && page.every(l => l.text.length <= 40) && !page.some((l, i) => l.kind === 'blank' && page[i + 1]?.kind === 'blank'), JSON.stringify(page))
  check('a wrapped item hangs its continuation under the first word', page.filter(l => l.kind === 'item').slice(1).every(l => l.text.startsWith('  ')), JSON.stringify(page.filter(l => l.kind === 'item')))
  check('the footer names the selected row\'s action once and the close hint', layout.memoryFooter({ kind: 'overview', action: 'run now' }) === '↑↓ move · ↵ run now · esc or click outside closes' && layout.memoryFooter({ kind: 'overview', action: null }) === '↑↓ move · esc or click outside closes')
  check('the sub-view footers back out with esc; the page footer scrolls only when the page overflows', layout.memoryFooter({ kind: 'list', open: 'open', empty: false }).endsWith('esc back') && layout.memoryFooter({ kind: 'page', scrolls: false, editable: false }) === 'esc back' && layout.memoryFooter({ kind: 'page', scrolls: true, editable: false }) === '↑↓ scroll · esc back')
  check('the context line is the project name and the memory folder', layout.memoryPopupLine('/Users/someone/code/app/', '~/.mercury/projects/-Users-someone-code-app/memory/') === 'app · ~/.mercury/projects/-Users-someone-code-app/memory')
}

const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinFact } = await import('../../src/mneme/mnemeUsage.ts')
const { openEntry, closeEntry } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey, getMnemeHome } = await import('../../src/mneme/paths.ts')
const { appendJournalEntry } = await import('../../src/mneme/journal.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: true } }))
resetSettingsCache()
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const dir = mnemeLibraryDir()
for (const word of ['deploys', 'commits', 'reviews']) appendObservation({ text: `About ${word}: handle ${word} the careful way and say exactly what happened.`, source: 'operator', topicHint: 'rules' }, dir)
appendObservation({ text: 'The owner prefers short plain rows in every table.', source: 'operator', topicHint: 'preferences' }, dir)
maybeConsolidate({ force: true, dir })
const rules = listTopicDocs(dir).find(d => d.slug === 'rules')!
for (const e of rules.sections[0]!.entries.slice(0, 2)) pinFact(e.seq, dir, new Date(), { asked: true })
maybeConsolidate({ force: true, dir })
const key = mnemeProjectKey()
const me = String(getSessionId())
openEntry(key, { sessionId: 'earlier-1', model: 'claude-fable-5-1' })
closeEntry(key, 'earlier-1', { outcome: 'closed', handoff: 'The work is the memory centre.\nStill to do: the lineage row.' })
openEntry(key, { sessionId: 'earlier-2', model: 'gpt-6-astra' })
closeEntry(key, 'earlier-2', { outcome: 'closed' })
openEntry(key, { sessionId: me, model: 'claude-fable-5-1' })
const realNow = Date.now
Date.now = () => Date.UTC(2026, 9, 11, 2, 15, 30)
appendJournalEntry(key, 'I set up the journal view. The operator wanted the rows short and plain.\n\nI got the first heading wrong and said so.')
Date.now = () => Date.UTC(2026, 9, 11, 3, 40, 0)
appendJournalEntry(key, 'Second session. The operator asked for the entry to open on ↵; I had put it behind a key and corrected that.')
Date.now = realNow

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
type Rect = { left: number; right: number; top: number; bottom: number }
const cellAt = (lines: string[], x: number, y: number): string => Array.from(lines[y] ?? '')[x] ?? ' '
function frameOf(lines: string[]): Rect | null {
  const y = lines.findLastIndex(line => line.includes(TITLE))
  if (y < 0) return null
  const titleAt = lines[y]!.indexOf(TITLE)
  const left = lines[y]!.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = y
  while (top >= 0 && cellAt(lines, left, top) !== '╭') top--
  if (top < 0) return null
  const right = Array.from(lines[top]!).findIndex((c, x) => x > left && c === '╮')
  let bottom = top + 1
  while (bottom < lines.length && cellAt(lines, left, bottom) !== '╰') bottom++
  return right < 0 || bottom >= lines.length ? null : { left, right, top, bottom }
}
const inside = (lines: string[], frame: Rect): string[] => lines.slice(frame.top + 1, frame.bottom).map(line => Array.from(line).slice(frame.left + 1, frame.right).join('').replace(/\s+$/, ''))
const rowOf = (m: Mounted, needle: string): string => m.lines().find(l => l.includes(needle)) ?? ''
async function moveTo(m: Mounted, needle: string): Promise<string> {
  for (let step = 0; step < 10 && !rowOf(m, needle).includes('❯'); step++) m.push(KEY.up)
  await settle(60)
  for (let step = 0; step < 14 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}

type Scene = { m: Mounted; done: unknown[][]; columns: number; rows: number }
async function openMemory(columns: number, rows: number, args = ''): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(100)
  const done: unknown[][] = []
  const element = await memoryCommand.call((...call: unknown[]) => { done.push(call) }, { messages: [], options: {} } as never, args)
  check(`${columns}x${rows}: /memory${args ? ` ${args}` : ''} opens the popup and mounts no band of its own`, element === null && settingsStore.isSettingsPopupOpen() && settingsStore.settingsPopupRequest()?.view === 'memory')
  const painted = await waitFor(() => m.screen().includes(TITLE) && (args === 'files' ? m.screen().includes('Memory: on') : m.screen().includes('section')), 8000)
  check(`${columns}x${rows}: the popup painted its title and body`, painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(250)
  return { m, done, columns, rows }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}
function judgeFrame(label: string, scene: Scene): Rect | null {
  const lines = scene.m.lines()
  const frame = frameOf(lines)
  check(`${label}: the popup is one closed rounded frame inside the terminal`, frame !== null && frame.left >= 0 && frame.right < scene.columns && frame.top >= 0 && frame.bottom < scene.rows, JSON.stringify(frame))
  check(`${label}: no painted row is wider than the terminal`, lines.every(l => Array.from(l).length <= scene.columns), String(Math.max(...lines.map(l => Array.from(l).length))))
  if (frame === null) return null
  const width = frame.right - frame.left + 1
  const top = Array.from(lines[frame.top]!).slice(frame.left, frame.right + 1).join('')
  const bottom = Array.from(lines[frame.bottom]!).slice(frame.left, frame.right + 1).join('')
  check(`${label}: the border closes without interruption`, top === `╭${'─'.repeat(width - 2)}╮` && bottom === `╰${'─'.repeat(width - 2)}╯` && lines.slice(frame.top + 1, frame.bottom).every((_, i) => cellAt(lines, frame.left, frame.top + 1 + i) === '│' && cellAt(lines, frame.right, frame.top + 1 + i) === '│'))
  check(`${label}: the frame is centred in its host`, Math.abs(frame.left - (scene.columns - 1 - frame.right)) <= (scene.columns >= 100 ? 26 : 2), `left ${frame.left} · right gap ${scene.columns - 1 - frame.right}`)
  return frame
}
function judgeOverview(label: string, scene: Scene): void {
  const frame = judgeFrame(label, scene)
  if (frame === null) return
  const body = inside(scene.m.lines(), frame)
  const title = body.findIndex(l => l.includes(TITLE))
  const context = body[title + 1] ?? ''
  check(`${label}: the context line under the title names the project and the memory folder`, context.includes(layout.memoryPopupLine(process.cwd(), getMnemeHome()).slice(0, 20)), context)
  const search = body.findIndex(l => l.trim().startsWith('/ ') && l.includes(layout.MEMORY_SEARCH_PLACEHOLDER))
  check(`${label}: the search line stands at the top of the body`, search > title + 1 && search <= title + 4, body.slice(0, 6).join(' | '))
  const header = body.findIndex(l => /^\s+section\s+count\s+newest\s+state$/.test(l))
  check(`${label}: the overview is a table with the four column headers`, header > search, body.slice(search, search + 4).join(' | '))
  if (header < 0) return
  const head = body[header]!
  const columns = { section: head.indexOf('section'), count: head.indexOf('count'), newest: head.indexOf('newest'), state: head.indexOf('state') }
  const expected: Array<[string, string, string]> = [['facts and decisions', '4 current', 'on'], ['pinned rules', '2 · 280 of 8k', 'loaded'], ['topics', '2 pages', 'indexed'], ['lineage', 'session 3 · 2 before', 'no note'], ['journal', '2 entries', 'on'], ['maintenance', 'none', 'idle'], ['instruction files', '', 'auto']]
  const rows = body.slice(header + 1, header + 1 + expected.length)
  check(`${label}: one row per section, in the brief's order`, expected.every(([section], i) => (rows[i] ?? '').includes(section)), rows.join(' | '))
  check(`${label}: the section and count columns start under their headers in every row`, expected.every(([section, count], i) => { const r = rows[i] ?? ''; return r.indexOf(section) === columns.section && (count === '' || r.indexOf(count) === columns.count) }), rows.join(' | '))
  const stampAt = (r: string): number => r.search(/\d\d [A-Z][a-z]{2} \d\d:\d\d|—/)
  check(`${label}: the newest column is a human date (or a dash) under its header`, rows.every(r => stampAt(r) === columns.newest), rows.map(r => `${stampAt(r)}`).join(','))
  check(`${label}: the state column reads one word under its header`, expected.every(([, , state], i) => (rows[i] ?? '').slice(columns.state).trim() === state), rows.map(r => r.slice(columns.state)).join(' | '))
  check(`${label}: the row words are the table's, not run-on lines`, rows.every(r => !r.includes('↵') && !r.includes(': ')), rows.join(' | '))
  const footer = body.findLastIndex(l => l.includes(layout.MEMORY_CLOSE_HINT))
  check(`${label}: the footer carries the keys once, with the close hint`, footer > header && body[footer]!.includes('↑↓ move'), body[footer] ?? '')
  const detail = body.slice(header + 1, footer).find(l => l.includes('facts live in topic pages'))
  check(`${label}: the selected row's detail reads under the table`, detail !== undefined, body.slice(header + 1, footer).join(' | '))
}

for (const [columns, rows] of [[80, 24], [100, 30], [120, 40]] as const) {
  section(`§2 the overview at ${columns}x${rows}`)
  const scene = await openMemory(columns, rows)
  save(`memory-overview-${columns}x${rows}`, scene.m.lines())
  judgeOverview(`${columns}x${rows}`, scene)
  const pinned = await moveTo(scene.m, 'pinned rules')
  check(`${columns}x${rows}: the pinned row takes the cursor and the footer names its action`, pinned.includes('❯') && rowOf(scene.m, layout.MEMORY_CLOSE_HINT).includes('↵ list the rules'), rowOf(scene.m, layout.MEMORY_CLOSE_HINT))
  scene.m.push(KEY.enter)
  const listed = await waitFor(() => scene.m.screen().includes('memory › pinned rules'), 6000)
  check(`${columns}x${rows}: ↵ opens the pinned list under a breadcrumb, the overview collapsed`, listed && !scene.m.screen().includes('facts and decisions'), rowOf(scene.m, 'memory ›'))
  await settle(150)
  save(`memory-pinned-${columns}x${rows}`, scene.m.lines())
  judgeFrame(`${columns}x${rows} pinned list`, scene)
  check(`${columns}x${rows}: the list carries both pinned rules with their size and the asked mark`, scene.m.lines().filter(l => /chars · asked for by you · About (deploys|commits):/.test(l)).length === 2, scene.m.lines().filter(l => l.includes('chars ·')).join(' | '))
  for (const ch of 'commits') scene.m.push(ch)
  const filtered = await waitFor(() => rowOf(scene.m, '/ commits') !== '' && !scene.m.screen().includes('About deploys:'), 6000)
  check(`${columns}x${rows}: typing filters the open list — only the matching rule stays`, filtered && scene.m.screen().includes('About commits:'), scene.m.lines().filter(l => l.includes('About')).join(' | '))
  scene.m.push(KEY.esc)
  const cleared = await waitFor(() => scene.m.screen().includes('About deploys:') && !scene.m.screen().includes('/ commits'), 6000)
  check(`${columns}x${rows}: esc clears the search and the whole list returns`, cleared)
  scene.m.push(KEY.esc)
  const back = await waitFor(() => scene.m.screen().includes('facts and decisions'), 6000)
  check(`${columns}x${rows}: esc again returns to the overview`, back)
  scene.m.push(KEY.esc)
  const closed = await waitFor(() => !scene.m.screen().includes(TITLE) && !settingsStore.isSettingsPopupOpen(), 6000)
  check(`${columns}x${rows}: esc on the overview closes the popup`, closed)
  check(`${columns}x${rows}: the command settles once, with nothing to say in the transcript`, scene.done.length === 1 && JSON.stringify(scene.done[0]) === JSON.stringify([undefined, { display: 'skip' }]), JSON.stringify(scene.done))
  await closeScene(scene)
}

section('§3 the lineage as a table and a session\'s note as a page (120x40, then the same page at 80x24 and 100x30)')
for (const [columns, rows] of [[120, 40], [100, 30], [80, 24]] as const) {
  const scene = await openMemory(columns, rows)
  await moveTo(scene.m, 'lineage')
  check(`${columns}x${rows}: the lineage row's footer offers the sessions`, rowOf(scene.m, layout.MEMORY_CLOSE_HINT).includes('↵ open the sessions'))
  scene.m.push(KEY.enter)
  const table = await waitFor(() => scene.m.screen().includes('memory › lineage') && /session\s+engine\s+started\s+ended\s+note/.test(scene.m.screen()), 6000)
  check(`${columns}x${rows}: ↵ opens the lineage table with its five columns`, table, scene.m.lines().filter(l => l.includes('│ │') || l.includes('session')).slice(0, 6).join(' | '))
  await settle(150)
  const lines = scene.m.lines()
  const frame = frameOf(lines)
  const body = frame ? inside(lines, frame) : []
  const head = body.find(l => /session\s+engine\s+started\s+ended\s+note/.test(l)) ?? ''
  const at = (word: string) => head.indexOf(word)
  const sessionRows = body.filter(l => /^\s+(❯\s+)?[123]( \(this\))?\s+(claude-fable-5-1|gpt-6-astra)\s+\d\d [A-Z][a-z]{2} \d\d:\d\d/.test(l))
  check(`${columns}x${rows}: three session rows, newest first, this session marked`, sessionRows.length === 3 && sessionRows[0]!.includes('3 (this)') && /\s1\s+claude/.test(sessionRows[2] ?? ''), sessionRows.join(' | '))
  check(`${columns}x${rows}: the engine, started, ended and note cells sit under their headers`, sessionRows.length === 3 && sessionRows.every(r => r.search(/claude|gpt/) === at('engine') && r.search(/\d\d [A-Z][a-z]{2} \d\d:\d\d/) === at('started')) && at('note') > at('ended') && at('ended') > at('started') && at('engine') > at('session'), `${head}\n${sessionRows.join('\n')}`)
  check(`${columns}x${rows}: the note column says yes for the noted session and no for the rest`, sessionRows.length === 3 && sessionRows[2]!.slice(at('note')).trim() === 'yes' && sessionRows[0]!.slice(at('note')).trim() === 'no' && sessionRows[1]!.slice(at('note')).trim() === 'no', sessionRows.map(r => r.slice(at('note'))).join(' | '))
  check(`${columns}x${rows}: this session's end reads open; a session that never closed reads unclosed only when it did not`, sessionRows.length === 3 && sessionRows[0]!.slice(at('ended'), at('note')).trim() === 'open', sessionRows[0] ?? '')
  if (columns === 120) save(`memory-lineage-${columns}x${rows}`, lines)
  const noted = await moveTo(scene.m, ' 1 ')
  check(`${columns}x${rows}: the noted session takes the cursor and the footer offers its note`, noted.includes('❯') && rowOf(scene.m, 'esc back').includes('↵ read the note'), rowOf(scene.m, 'esc back'))
  scene.m.push(KEY.enter)
  const page = await waitFor(() => scene.m.screen().includes('memory › lineage › session 1') && scene.m.screen().includes('The work is the memory centre.'), 6000)
  check(`${columns}x${rows}: ↵ opens the session's note as a page, the note word for word`, page && scene.m.screen().includes('Still to do: the lineage row.'), scene.m.lines().filter(l => l.includes('│ │')).slice(0, 8).join(' | '))
  await settle(120)
  save(`memory-note-${columns}x${rows}`, scene.m.lines())
  judgeFrame(`${columns}x${rows} note page`, scene)
  check(`${columns}x${rows}: the page names the session, its engine and when the note was left`, rowOf(scene.m, 'session 1 — the note it left') !== '' && rowOf(scene.m, 'claude-fable-5-1 · note left') !== '')
  scene.m.push(KEY.esc)
  const backToTable = await waitFor(() => scene.m.screen().includes('memory › lineage ·'), 6000)
  check(`${columns}x${rows}: esc returns to the table`, backToTable)
  scene.m.push(KEY.esc)
  await waitFor(() => scene.m.screen().includes('facts and decisions'), 6000)
  await closeScene(scene)
}

section('§4 the journal newest first and an entry as a page; the topics and a topic page (120x40)')
{
  const scene = await openMemory(120, 40)
  await moveTo(scene.m, 'journal')
  scene.m.push(KEY.enter)
  const listed = await waitFor(() => scene.m.screen().includes('memory › journal') && scene.m.screen().includes('Second session.'), 6000)
  check('↵ on the journal row lists the entries', listed)
  await settle(120)
  const lines = scene.m.lines()
  const newest = lines.findIndex(l => l.includes('Second session.'))
  const older = lines.findIndex(l => l.includes('I set up the journal view.'))
  check('the newest entry stands first, each dated in the human form', newest >= 0 && older > newest && /\d\d Oct \d\d:\d\d  Second session\./.test(lines[newest]!), `${lines[newest]} / ${lines[older]}`)
  check('the legend says the journal is kept in the home and never synced', lines.some(l => l.includes('kept in the Mercury home, never pushed or synced')))
  save('memory-journal-120x40', lines)
  scene.m.push(KEY.enter)
  const opened = await waitFor(() => scene.m.screen().includes('corrected that.'), 6000)
  check('↵ opens the entry as a page, wrapped whole', opened && scene.m.screen().includes('memory › journal ›'), scene.m.lines().filter(l => l.includes('│ │')).slice(0, 8).join(' | '))
  check('the page names the time, whose words these are and the file', rowOf(scene.m, 'written 2026-10-11 03:40 UTC · the model\'s own words · ') !== '')
  scene.m.push('c')
  await settle(80)
  check('a letter while the page is open changes nothing', !scene.m.screen().includes('/ c') && scene.m.screen().includes('corrected that.'))
  scene.m.push(KEY.esc)
  await waitFor(() => scene.m.screen().includes('memory › journal ·'), 6000)
  scene.m.push(KEY.esc)
  await waitFor(() => scene.m.screen().includes('facts and decisions'), 6000)
  await moveTo(scene.m, 'topics')
  scene.m.push(KEY.enter)
  const topics = await waitFor(() => scene.m.screen().includes('memory › topics') && scene.m.screen().includes('rules (3 facts)'), 6000)
  check('↵ on the topics row lists the topics with their summaries, as the index reads them', topics && scene.m.screen().includes('preferences'), scene.m.lines().filter(l => l.includes('│ │')).slice(0, 8).join(' | '))
  await settle(100)
  save('memory-topics-120x40', scene.m.lines())
  await moveTo(scene.m, 'rules (3 facts)')
  scene.m.push(KEY.enter)
  const page = await waitFor(() => scene.m.screen().includes('memory › topics › rules') && scene.m.screen().includes('About deploys:'), 6000)
  check('↵ opens the topic page: its facts as items under their heading, the meta line counting them', page && rowOf(scene.m, '3 facts · 0 in history · updated') !== '' && scene.m.lines().some(l => /•\s+About deploys:/.test(l)))
  await settle(100)
  save('memory-topic-page-120x40', scene.m.lines())
  scene.m.push(KEY.esc)
  await waitFor(() => scene.m.screen().includes('memory › topics ·'), 6000)
  scene.m.push(KEY.esc)
  await waitFor(() => scene.m.screen().includes('facts and decisions'), 6000)
  for (const ch of 'deploys') scene.m.push(ch)
  const hits = await waitFor(() => scene.m.screen().includes('matches for “deploys”') && scene.m.screen().includes('About deploys:'), 6000)
  check('typing on the overview searches the facts and rules', hits, rowOf(scene.m, 'matches for'))
  scene.m.push(KEY.enter)
  const detail = await waitFor(() => /seq \d+ · pinned · asked for by you/.test(scene.m.screen()) && scene.m.screen().includes('c correct · x retire'), 6000)
  check('↵ opens the fact with its verbs and the page it lives on, the fact marked', detail && scene.m.lines().some(l => /❯\s+•\s+About deploys:/.test(l)), scene.m.lines().filter(l => l.includes('│ │')).slice(0, 10).join(' | '))
  await closeScene(scene)
}

section('§5 the instruction files picker rides the same popup; /memory files opens straight into it')
{
  const scene = await openMemory(120, 40)
  await moveTo(scene.m, 'instruction files')
  check('the files row\'s footer offers the picker', rowOf(scene.m, layout.MEMORY_CLOSE_HINT).includes('↵ open the picker'))
  scene.m.push(KEY.enter)
  const picker = await waitFor(() => scene.m.screen().includes('Memory: on') && scene.m.screen().includes('profile auto:'), 8000)
  check('↵ opens the picker inside the popup, the title kept', picker && scene.m.screen().includes(TITLE) && rowOf(scene.m, 'open in editor').includes('esc back'))
  scene.m.push(KEY.esc)
  const back = await waitFor(() => scene.m.screen().includes('facts and decisions'), 6000)
  check('esc from the picker returns to the centre', back && scene.done.length === 0)
  await closeScene(scene)
  const direct = await openMemory(120, 40, 'files')
  check('/memory files opens the picker directly, its footer closing rather than backing', rowOf(direct.m, 'open in editor').includes(layout.MEMORY_CLOSE_HINT))
  direct.m.push(KEY.esc)
  const closed = await waitFor(() => !direct.m.screen().includes(TITLE), 6000)
  check('esc closes it outright with the closed line', closed && JSON.stringify(direct.done[0]) === JSON.stringify([memoryCommand.MEMORY_FILES_CLOSED, { display: 'system' }]), JSON.stringify(direct.done))
  await closeScene(direct)
}

await releaseScratchHome(HOME)
console.log(`\nmemory centre popup: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
