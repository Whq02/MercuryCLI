#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-memory-pending-keys')
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

const TAIL = 'kept word for word to the last syllable'
const PENDING = `The operator is writing this todo app (todo.py in m34-play) to learn Python with the zebrafinch runner. (context: stated at the start of session 3 as a standing fact about the work, ${TAIL})`
const CORRECTED = 'The operator is writing this todo app to learn Python with the zebrafinch runner, in the evenings'
const SETTLED = 'The staging database for this project is called stagedb7.'

const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
const { appendObservation, pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinPendingRow, replacePendingRow, strikePendingRow } = await import('../../src/mneme/mnemeCorrect.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
resetSettingsCache()
const dir = mnemeLibraryDir()
appendObservation({ text: SETTLED, source: 'tool:Retain s:83fe6475', topicHint: 'general' }, dir)
maybeConsolidate({ force: true, dir })
appendObservation({ text: PENDING, source: 'tool:Retain s:83fe6475', topicHint: 'about-the-operator' }, dir)
const pendingTs = (): string | undefined => pendingRows(dir).find(r => r.text.includes('zebrafinch'))?.ts

section('§1 the pending-row roads: pin marks the row for its consolidation, idempotently; a row that is gone is named')
{
  const first = pendingTs()
  check('the row waits in the pending store', first !== undefined && pendingRows(dir).length === 1, JSON.stringify(pendingRows(dir).map(r => r.text.slice(0, 40))))
  const pin = (input: { ts: string; dir: string; byUser: boolean }): { ok: boolean; code?: string; row?: { pin?: boolean; asked?: boolean; text: string } | null } =>
    typeof pinPendingRow === 'function' ? pinPendingRow(input) : { ok: false, code: 'no-road' }
  const pinned = pin({ ts: first!, dir, byUser: true })
  check('pin rewrites the row pinned and asked for, its words intact', pinned.ok && pinned.row?.pin === true && pinned.row?.asked === true && pinned.row?.text === PENDING && pendingRows(dir).length === 1, JSON.stringify(pinned))
  const again = pin({ ts: pendingTs()!, dir, byUser: true })
  check('pinning a pinned row changes nothing and still answers ok', again.ok && pendingRows(dir).length === 1 && pendingRows(dir)[0]!.pin === true, JSON.stringify(again))
  const gone = pin({ ts: '1999-01-01T00:00:00.000Z', dir, byUser: true })
  check('a row that is not there is refused by name', !gone.ok && gone.code === 'unknown-target', JSON.stringify(gone))
  const unpinnedAgain = strikePendingRow({ ts: pendingTs()!, dir, byUser: true })
  check('(reset for the screen leg) the pinned row is struck', unpinnedAgain.ok && pendingRows(dir).length === 0)
  appendObservation({ text: PENDING, source: 'tool:Retain s:83fe6475', topicHint: 'about-the-operator' }, dir)
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
const footerOf = (m: Mounted): string => m.lines().findLast(l => (l.includes('esc back') || l.includes('esc clears the search') || l.includes('esc cancel')) && !l.includes('/ esc back')) ?? ''
const bodyText = (m: Mounted): string => m.lines().map(l => l.replace(/│/g, ' ').trim()).join(' ').replace(/\s+/g, ' ')
const type = async (m: Mounted, text: string): Promise<void> => {
  for (const ch of text) m.push(ch)
  await settle(120)
}

section('§2 a pending fact opened from the search shows its whole body and acts with the same keys as a consolidated one (120x40)')
{
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const m = await mountOffscreen(wrap(h(Harness, { columns: 120 })), 120, 40)
  await waitFor(() => m.screen().includes('TTTT'), 4000)
  await settle(100)
  const element = await memoryCommand.call(() => {}, { messages: [], options: {} } as never, '')
  check('/memory opens the popup', element === null && settingsStore.isSettingsPopupOpen() && settingsStore.settingsPopupRequest()?.view === 'memory')
  const painted = await waitFor(() => m.screen().includes(TITLE) && m.screen().includes('section'), 8000)
  check('the popup painted', painted, m.lines().filter(l => l.trim()).slice(0, 8).join(' | '))
  await settle(250)
  await type(m, 'zebrafinch')
  const found = await waitFor(() => rowOf(m, 'matches for “zebrafinch”').includes('1 match') && m.screen().includes('The operator is writing this todo app'), 6000)
  check('the search finds the pending fact', found, rowOf(m, 'matches for'))
  m.push(KEY.enter)
  const opened = await waitFor(() => m.screen().includes('recent, unconsolidated') && footerOf(m).includes('esc back') && m.screen().includes('consolidates at the next maintenance pass'), 6000)
  check('↵ opens the pending fact, headed recent, unconsolidated, with when it was saved', opened && rowOf(m, 'saved ').includes('from the chat'), `${footerOf(m)} · ${rowOf(m, 'saved ').trim()}`)
  await settle(200)
  save('pending-open-120x40', m.lines())
  check('the whole body is on the page — its last words included, nothing clipped at the context', bodyText(m).includes(TAIL) && !bodyText(m).includes('(context…'), m.lines().filter(l => l.includes('context') || l.includes('syllable')).map(l => l.trim()).join(' | '))
  check('the footer offers the keys a consolidated fact has: c correct · x retire · p pin · esc back', footerOf(m).includes('c correct · x retire · p pin · esc back'), footerOf(m))

  m.push('p')
  const pinnedNote = await waitFor(() => m.screen().includes('pinned word for word') && pendingRows(dir).some(r => r.text === PENDING && r.pin === true && r.asked === true), 8000)
  check('p marks the pending row pinned and asked for; the note says it lands pinned when it consolidates', pinnedNote && rowOf(m, 'pinned word for word').includes('lands pinned when it consolidates'), rowOf(m, 'pinned').trim())
  check('the fact view closed back to the search (the row changed under it)', m.screen().includes('matches for “zebrafinch”'), rowOf(m, 'matches for'))
  m.push(KEY.enter)
  const reopened = await waitFor(() => m.screen().includes('pinned from then on') && footerOf(m).includes('c correct'), 6000)
  check('reopened, the page says the row is pinned from its consolidation on and the footer drops p pin', reopened && footerOf(m).includes('c correct · x retire · esc back') && !footerOf(m).includes('p pin'), `${footerOf(m)} · ${rowOf(m, 'pinned from then on').trim()}`)
  save('pending-pinned-120x40', m.lines())

  m.push('c')
  const correcting = await waitFor(() => m.screen().includes('correcting the pending fact'), 6000)
  check('c opens the correction with the pending wording below it', correcting && m.screen().includes('zebrafinch runner'), rowOf(m, 'correcting').trim())
  await type(m, CORRECTED)
  m.push(KEY.enter)
  const corrected = await waitFor(() => m.screen().includes('corrected the pending fact') && pendingRows(dir).some(r => r.text === CORRECTED), 8000)
  check('↵ replaces the pending row with the new words — the old wording struck, the pin kept', corrected && pendingRows(dir).length === 1 && pendingRows(dir)[0]!.text === CORRECTED && pendingRows(dir)[0]!.pin === true && !pendingRows(dir).some(r => r.text === PENDING), JSON.stringify(pendingRows(dir).map(r => [r.text.slice(0, 40), r.pin])))
  save('pending-corrected-120x40', m.lines())

  m.push(KEY.enter)
  const third = await waitFor(() => m.screen().includes('in the evenings') && footerOf(m).includes('x retire'), 6000)
  check('the corrected row opens with its keys', third, footerOf(m))
  m.push('x')
  const armed = await waitFor(() => m.screen().includes('retire this pending fact? x again strikes it'), 6000)
  check('x asks before it strikes', armed, rowOf(m, 'retire this').trim())
  m.push('x')
  const struck = await waitFor(() => m.screen().includes('retired the pending fact') && pendingRows(dir).length === 0, 8000)
  check('x again strikes the pending row before it consolidates; nothing waits in the store', struck, JSON.stringify(pendingRows(dir).map(r => r.text.slice(0, 40))))
  save('pending-retired-120x40', m.lines())
  settingsStore.closeSettingsPopup()
  await settle(60)
  m.unmount()
  resetOverlayStackForTests()
}

section('§3 the correction road refuses an empty or over-long wording and keeps the row')
{
  appendObservation({ text: PENDING, source: 'tool:Retain s:83fe6475', topicHint: 'about-the-operator' }, dir)
  const empty = replacePendingRow({ ts: pendingTs()!, text: '   ', source: 'operator', dir, byUser: true })
  check('an empty correction is refused and the row stays', !empty.ok && empty.code === 'invalid' && pendingRows(dir).length === 1, JSON.stringify(empty))
  const long = replacePendingRow({ ts: pendingTs()!, text: 'x'.repeat(2100), source: 'operator', dir, byUser: true })
  check('an over-long correction is refused with the limit named and the row stays', !long.ok && long.code === 'invalid' && pendingRows(dir).length === 1, JSON.stringify(long).slice(0, 200))
}

releaseScratchHome(HOME)
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
