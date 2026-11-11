#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'
import { pinSourceRef, pinScratchHome, mountOffscreen, waitFor, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const home = pinScratchHome('status-card-key-owner')
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { Select } = await import('../../src/components/CustomSelect/select.tsx')
const { FocusedSessionStatusRow, escBackHint } = await import('../../src/components/SwitchboardTagBar.tsx')
const { crewmateStatusRightHint } = await import('../../src/utils/cockpit/crewmateWords.ts')
const { PromptInputFooterLeftSide } = await import('../../src/components/PromptInput/PromptInputFooterLeftSide.tsx')
const { CompactWorkSummary } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { useHoldsEscape } = await import('../../src/hooks/useEscapeOwned.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const status = { title: 'a chat', projectLabel: 'fixture', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }
const live = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' as const }
for (const [name, state] of [['running', status], ['interrupting', { ...status, interrupting: true }], ['hard stopping', { ...status, hardStopping: true }]] as const) {
  const hint = Reflect.apply(escBackHint, undefined, [live, state, true, true, true]) as string
  check(`${name}: a card leaves the status row no Escape action`, !/\besc\b/.test(hint), hint)
  check(`${name}: other hint clauses are unchanged`, hint === escBackHint(live, state, true, true).split(' · ').filter(part => !part.startsWith('esc ')).join(' · '), hint)
}
for (const pinned of [false, true]) for (const running of [false, true]) {
  const hint = Reflect.apply(crewmateStatusRightHint, undefined, [pinned, running, true]) as string
  check(`crewmate pinned=${pinned} running=${running}: no Escape action under a card`, !/\besc\b/.test(hint), hint)
  check(`crewmate pinned=${pinned} running=${running}: other hint clauses are unchanged`, hint === crewmateStatusRightHint(pinned, running).split(' · ').filter(part => !part.startsWith('esc ')).join(' · '), hint)
}
let roster: { rows: WorkRowV1[]; mission: never[]; samples: never[] } = { rows: [], mission: [], samples: [] }
const project = join(home, 'fixture')
mkdirSync(project)
const workspace = { cwd: project, originalCwd: project, projectRoot: project }
const fixture = Object.assign(Object.create(noSessionConnector()), {
  sessionId: () => 'status-card-fixture',
  records: () => [],
  subscribeRecords: () => () => {},
  modelFacts: () => ({ effective: 'claude-opus-5-5', effectiveSource: 'live', main: 'claude-opus-5-5', setting: null, sessionPin: null, effort: 'high', effortSent: null, pendingSwitch: null }),
  subscribeModel: () => () => {},
  workspace: () => workspace,
  workRoster: () => roster,
  subscribeWork: () => () => {},
  live: () => live,
  subscribeLive: () => () => {},
  status: () => status,
  tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
})
focused.setFocusedSessionConnector(fixture)
for (const [columns, rows, view] of [[120, 40, 'lead'], [213, 60, 'lead'], [213, 60, 'running-crew'], [213, 60, 'landed-crew']] as const) {
  roster = { rows: view === 'lead' ? [] : [{ id: 'helper', kind: 'agent', name: 'helper', status: view === 'running-crew' ? 'running' : 'completed', startTime: 1_700_000_000_000, model: 'claude-opus-5-5', effort: 'high' }], mission: [], samples: [] }
  const label = `${columns}x${rows}-${view}`
  let open = (): void => {}
  let declined = 0
  let hold = (_held: boolean): void => {}
  function Frame(): React.ReactNode {
    const [shown, setShown] = React.useState(false)
    const [held, setHeld] = React.useState(false)
    open = () => setShown(true)
    hold = setHeld
    useHoldsEscape(held)
    return h(Box, { width: columns, flexDirection: 'column' }, h(FocusedSessionStatusRow), h(PromptInputFooterLeftSide, { exitPending: false, exitKeyName: null, isPasting: false, mode: 'prompt', isLoading: true }), h(CompactWorkSummary, { columns, focused: false, onFocus: () => {} }), shown ? h(Box, { flexDirection: 'column' }, h(Text, null, 'Confirmation'), h(Select, { options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], onCancel: () => { declined++; setShown(false) } }), h(Text, null, 'esc declines')) : h(Text, null, 'Conversation'))
  }
  const scene = await mountOffscreen(h(App, { initialState: { ...getDefaultAppState(), ...(view === 'lead' ? {} : { viewingAgentTaskId: 'helper' }) }, getFpsMetrics: () => undefined, children: h(KeybindingSetup, { children: h(Frame) }) }), columns, rows)
  try {
    await settledFrame(scene, frame => frame.includes('esc ') && frame.includes('sessions on'))
    const before = scene.screen()
    const footerWords = view === 'lead' ? 'esc interrupt' : view === 'running-crew' ? 'esc interrupt helper' : 'esc back to'
    const escLines = (frame: string): string[] => frame.split('\n').filter(line => /\besc\b/.test(line) && !line.includes('esc declines'))
    check(`${label}: with no card the line under the composer and the compact line each name Escape's action`, escLines(before).length === 3 && escLines(before)[1]!.includes(footerWords) && escLines(before)[2]!.includes('esc interrupts'), escLines(before).map(line => line.trim()).join(' | '))
    open()
    await settledFrame(scene, frame => frame.includes('Confirmation'))
    const during = scene.screen()
    check(`${label}: a mounted card removes the status Escape action`, !/\besc\b/.test(scene.lines()[0] ?? ''), scene.lines()[0])
    check(`${label}: the card keeps its own Escape words`, during.includes('esc declines'))
    check(`${label}: under the card neither the line under the composer nor the compact line names Escape`, escLines(during).length === 0, escLines(during).map(line => line.trim()).join(' | '))
    scene.push('\x1b')
    check(`${label}: Escape reaches the card's decline`, await waitFor(() => declined === 1, 3000))
    await settledFrame(scene, frame => frame.includes('Conversation') && frame.includes('esc '))
    check(`${label}: after the card leaves, the whole frame is restored`, scene.screen() === before)
    hold(true)
    await waitFor(() => escLines(scene.screen()).length === 0, 3000)
    check(`${label}: a holder of Escape that registers no overlay (help, history search, the message cursor) takes the Escape words off the row and both lines`, escLines(scene.screen()).length === 0, escLines(scene.screen()).map(line => line.trim()).join(' | '))
    hold(false)
    await waitFor(() => scene.screen() === before, 3000)
    check(`${label}: when that holder lets go the whole frame is restored`, scene.screen() === before, scene.screen().split('\n').flatMap((line, at) => (line !== before.split('\n')[at] ? [`${(before.split('\n')[at] ?? '').trim()} -> ${line.trim()}`] : [])).join(' | '))
    if (frames) {
      writeFileSync(join(frames, `${label}-before.txt`), before)
      writeFileSync(join(frames, `${label}-card.txt`), during)
      writeFileSync(join(frames, `${label}-after.txt`), scene.screen())
    }
  } finally { scene.unmount() }
}
focused.setFocusedSessionConnector(noSessionConnector())
const chat = readFileSync(join(import.meta.dir, '../../src/screens/Chat.tsx'), 'utf8')
check('the chat screen holds Escape for help, history search and the message cursor, the three that take the key and register no overlay', chat.includes('useHoldsEscape(helpOpen || isSearchingHistory || messageCursorActive)'))
console.log(`status-card-key-owner: ${checks} checks, ${failures} failed`)
await releaseScratchHome(home)
process.exit(failures ? 1 : 0)
