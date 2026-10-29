#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-counts')
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

const layout = await import('../../src/components/memory/memoryCentreLayout.ts')

section('§0 the layout: the maintenance row dates its newest run')
{
  const row = layout.maintenanceRow({ due: false, dueReason: null, running: false, degraded: [], lastConsolidatedAt: '2026-10-12T08:35:00.000Z', receipts: [{ ts: '2026-10-12T08:40:21.000Z', trigger: 'operator', ran: true, reason: 'forced → tidy-up only (buffer empty)' }, { ts: '2026-10-12T08:35:00.000Z', trigger: 'operator', ran: true, reason: 'forced → consolidated', entries: 1 }] })
  check('the newest column is the newest run, the one the detail names', row.newest === layout.humanStamp('2026-10-12T08:40:21.000Z') && row.detail.startsWith(`last run ${layout.humanStamp('2026-10-12T08:40:21.000Z')}`), j(row))
  const none = layout.maintenanceRow({ due: false, dueReason: null, running: false, degraded: [], lastConsolidatedAt: null, receipts: [] })
  check('no run yet reads a dash and no run yet', none.newest === '—' && none.detail === 'no run yet' && none.count === 'none', j(none))
}

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
resetSettingsCache()
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { runDueMaintenance, readMaintenanceReceipts } = await import('../../src/mneme/mnemeMaintenance.ts')
const dir = mnemeLibraryDir()

section('§1 the first forced maintenance run in a project with no memory folder yet does its tidy-up and says so')
{
  check('the library folder does not exist before the run', !existsSync(dir), dir)
  const out = await runDueMaintenance('operator', { force: true, dir })
  const receipts = readMaintenanceReceipts(dir, 10)
  check('the run ran and tidied up — never "consolidation in progress (lock held)" in an empty project', out.ran && !j(out).includes('lock held') && receipts.length === 1 && receipts[0]!.reason === 'forced → tidy-up only (buffer empty)', j({ out, receipts }))
  check('the folder exists now and no lock is left behind', existsSync(dir) && !existsSync(join(dir, '.consolidate.lock')))
}

section('§2 /memory stats pluralises')
{
  const memoryCommand = await import('../../src/commands/memory/memory.tsx')
  const said: unknown[][] = []
  await memoryCommand.call((...c: unknown[]) => { said.push(c) }, { messages: [], options: {} } as never, 'stats')
  const text = String(said[0]?.[0] ?? '')
  check('no "(s)" or "(ies)" on the user\'s screen', !/\(s\)|\(ies\)/.test(text) && /buffer: 0 rows/.test(text) && /0 topic pages · 0 live facts · 0 in history/.test(text), text)
}

const { openEntry, closeEntry, readLedger } = await import('../../src/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const key = mnemeProjectKey()
const HOSTED = '7d2b4c1e-0f3a-4b8c-9d6e-aa11bb22cc33'
check('the hosted chat\'s id is not this process\'s bootstrap id', HOSTED !== String(getSessionId()))
openEntry(key, { sessionId: 'earlier-1', model: 'claude-fable-5-1' })
closeEntry(key, 'earlier-1', { outcome: 'closed', handoff: 'the first note' })
openEntry(key, { sessionId: 'earlier-2', model: 'claude-fable-5-1' })
closeEntry(key, 'earlier-2', { outcome: 'closed' })
const resting = noSessionConnector()
setFocusedSessionConnector(new Proxy(resting, { get: (target, prop) => (prop === 'sessionId' ? () => HOSTED : Reflect.get(target, prop)) }))

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
  for (let step = 0; step < 10 && !rowOf(m, needle).includes('❯'); step++) m.push(KEY.up)
  await settle(60)
  for (let step = 0; step < 14 && !rowOf(m, needle).includes('❯'); step++) {
    m.push(KEY.down)
    await settle(40)
  }
  return rowOf(m, needle)
}
type Scene = { m: Mounted; columns: number; rows: number }
async function openMemory(columns: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(100)
  const element = await memoryCommand.call(() => {}, { messages: [], options: {} } as never, '')
  check(`${columns}x${rows}: /memory opens the popup`, element === null && settingsStore.isSettingsPopupOpen())
  const painted = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('section'), 8000)
  check(`${columns}x${rows}: the popup painted`, painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(250)
  return { m, columns, rows }
}
async function closeScene(scene: Scene): Promise<void> {
  settingsStore.closeSettingsPopup()
  await settle(60)
  scene.m.unmount()
  resetOverlayStackForTests()
}

section('§3 before the first turn: the chat has no ledger row yet — session 3 · 2 before')
for (const [columns, rows] of [[120, 40], [80, 24]] as const) {
  const scene = await openMemory(columns, rows)
  const lineage = rowOf(scene.m, 'lineage')
  check(`${columns}x${rows}: the lineage row reads session 3 · 2 before`, /lineage\s+session 3 · 2 before/.test(lineage), lineage.trim())
  await moveTo(scene.m, 'lineage')
  check(`${columns}x${rows}: its detail counts the two sessions before this one`, rowOf(scene.m, 'before this one').includes('2 sessions before this one'), rowOf(scene.m, 'before this one').trim())
  if (columns === 120) save('lineage-before-first-turn-120x40', scene.m.lines())
  await closeScene(scene)
}

section('§4 after the first turn: the runner wrote the chat\'s row under the chat\'s own id — still session 3 · 2 before, the row marked (this) and open')
openEntry(key, { sessionId: HOSTED, model: 'claude-sonnet-5-5' })
check('the ledger holds three rows, the newest under the hosted chat\'s id with no end', readLedger(key).length === 3 && readLedger(key)[2]!.sessionId === HOSTED && readLedger(key)[2]!.endedAt === null, j(readLedger(key).map(e => [e.ordinal, e.sessionId, e.endedAt])))
for (const [columns, rows] of [[120, 40], [100, 30], [80, 24]] as const) {
  const scene = await openMemory(columns, rows)
  const lineage = rowOf(scene.m, 'lineage')
  check(`${columns}x${rows}: the lineage row still reads session 3 · 2 before — the open chat is never "before"`, /lineage\s+session 3 · 2 before/.test(lineage), lineage.trim())
  await moveTo(scene.m, 'lineage')
  check(`${columns}x${rows}: the detail still counts two sessions before this one`, rowOf(scene.m, 'before this one').includes('2 sessions before this one'), rowOf(scene.m, 'before this one').trim())
  save(`lineage-row-after-first-turn-${columns}x${rows}`, scene.m.lines())
  scene.m.push(KEY.enter)
  const table = await waitFor(() => scene.m.screen().includes('memory › lineage ·'), 6000)
  check(`${columns}x${rows}: the view is titled 2 sessions before this one`, table && rowOf(scene.m, 'memory › lineage ·').includes('2 sessions before this one, newest first'), rowOf(scene.m, 'memory › lineage').trim())
  await settle(120)
  const own = rowOf(scene.m, '3 (this)')
  check(`${columns}x${rows}: the newest row is 3 (this), its end reads open, not unclosed`, own !== '' && /\bopen\b/.test(own) && !own.includes('unclosed'), own.trim() || scene.m.lines().filter(l => /^\s*│.*\b[123]\b.*claude/.test(l)).join(' | '))
  save(`lineage-view-after-first-turn-${columns}x${rows}`, scene.m.lines())
  await closeScene(scene)
}
releaseFocusedSessionConnector()

await releaseScratchHome(HOME)
console.log(`\nmemory counts: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
