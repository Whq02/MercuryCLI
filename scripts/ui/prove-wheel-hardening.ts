import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, pinSourceRef, type Mounted } from '../lib/settingsPopupHarness.js'
import type { BoardViewSnapshot } from '../../src/services/crewBoard/contracts.js'
import type { ParsedInput } from '../../src/ink/input/input-decoder.js'

pinSourceRef()
const HOME = pinScratchHome('wheel-hardening')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_OPERATOR = 'operator'
process.env.MERCURY_HOME = join(HOME, 'proof-home')
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_RECESS = '1'
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME, { recursive: true })
process.chdir(PROJECT)
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 120
const ROWS = 44
const PAGE = ROWS - 1
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const WHEEL_UP = '\x1b[<64;10;5M'
const WHEEL_DOWN = '\x1b[<65;10;5M'
const MOTION = '\x1b[<35;10;5M'
const DRAG = '\x1b[<32;10;5M'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const React = await import('react')
const h = React.createElement
const { Box } = await import('../../src/ink.js')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const route = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
const { PromptsPanel } = await import('../../src/components/prompts-panel/PromptsPanel.js')
const { coalesceWheelRun } = await import('../../src/ink/components/App.js')
const { resolveAlternateScrollIntent } = await import('../../src/ink/termio/alternateScrollPolicy.js')
const { parseMultipleKeypresses, INITIAL_STATE } = await import('../../src/ink/input/input-decoder.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)

const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 10, Math.floor(i / 60), i % 60)).toISOString()
const PROMPTS = 70
const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'wheel fixture', projectLabel: 'fixture', workspaceId: 'fixture', home: HOME })
connector.workspace = () => ({ cwd: PROJECT, projectRoot: PROJECT }) as ReturnType<typeof connector.workspace>
for (let i = 0; i < PROMPTS; i++) {
  connector.addDisplayRow({ ...createUserMessage({ content: `PROMPT_${String(i).padStart(2, '0')} inspect the selected module` }), timestamp: at(i * 2) })
  connector.addDisplayRow({ ...createAssistantMessage({ content: `ANSWER_${String(i).padStart(2, '0')} the module reads as expected` }), timestamp: at(i * 2 + 1) })
}
for (let i = 0; i < 6; i++) {
  connector.addDisplayRow({ ...createUserMessage({ content: `<crewmate-message crewmate_id="crew-${i}" summary="row ${i}">CREW_TRAFFIC_${i}</crewmate-message>` }), timestamp: at(200 + i) })
}
let boardOn = false
const board: BoardViewSnapshot = {
  on: true, snapshot: 40, omitted: 0, admitted: 40, peerTurns: 0,
  events: Array.from({ length: 40 }, (_, i) => ({
    schema: 1, boardId: 'fixture', waveId: 'fixture', seq: i + 1, eventId: `event-${i}`, clientOpId: `post-${i}`, kind: 'result', author: { sessionId: 'fixture', agentId: `crew-${i % 3}`, executionId: 'fixture' }, authorName: `crew-${i % 3}`, mentions: [], relatedTasks: [], files: [], refs: [], createdAt: at(i), payloadDigest: '', threadId: `thread-${i}`, policyRevision: 1,
    text: `BOARD_POST_${String(i).padStart(2, '0')} the lane reports a settled row`,
  })),
}
connector.swarmBoard = () => boardOn ? board : null
slot.setFocusedSessionConnector(connector)
route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})

const listRows = (m: Mounted): string[] => m.lines().filter(line => /^│ [▸ ] (\d\d:\d\d|queued) /.test(line))
const selectedPrompt = (m: Mounted): string | undefined => m.lines().find(line => /^│ ▸ /.test(line))?.match(/PROMPT_\d\d/)?.[0]
const sectionsLine = (m: Mounted): string | undefined => m.lines().find(line => /PROMPTS \(\d+\)/.test(line))
const transcriptRows = (m: Mounted): string[] => m.lines().map(line => line.match(/(?:PROMPT|ANSWER)_\d\d/g)?.join(' ') ?? '').filter(Boolean)
const composerRow = (m: Mounted): string => m.lines().find(line => /^│[❯!] /.test(line)) ?? ''
const noop = (): void => {}

let mounted: Mounted | undefined
let scene = 0
async function openPanel(): Promise<Mounted> {
  const element = h(AppStateProvider, { children: h(KeybindingSetup, { children: h(Box, { key: ++scene, width: COLS, height: ROWS, flexDirection: 'column' }, h(PromptsPanel, { onClose: noop })) }) })
  if (mounted) mounted.resize(element, COLS, ROWS)
  else mounted = await mountOffscreen(element, COLS, ROWS, { mouseTracking: true })
  await settle(180)
  return mounted
}
async function push(m: Mounted, data: string, ms = 120): Promise<void> {
  m.push(data)
  await settle(ms)
}

try {
  section('§1 the wheel gesture: one chunk is one gesture, netted and capped at a page')
  const wheel = (name: 'wheelup' | 'wheeldown'): ParsedInput => ({ kind: 'key', name, fn: false, ctrl: false, meta: false, shift: false, option: false, super: false, sequence: '', raw: '', isPasted: false, x: 10, y: 5 })
  const key = (name: string): ParsedInput => ({ kind: 'key', name, fn: false, ctrl: false, meta: false, shift: false, option: false, super: false, sequence: '', raw: '', isPasted: false })
  if (typeof coalesceWheelRun !== 'function') check('the App coalesces a chunk of wheel reports into one gesture', false, 'coalesceWheelRun is not exported by src/ink/components/App.tsx')
  else {
    const one = coalesceWheelRun([wheel('wheelup')], 0, PAGE)
    check('one notch is one step (a selection moves one row; a scrolling body takes three rows per step)', one.steps === 1 && one.end === 1 && one.atom?.name === 'wheelup')
    const forty = coalesceWheelRun(Array.from({ length: 40 }, () => wheel('wheeldown')), 0, PAGE)
    check(`forty notches in one chunk are capped at a page of body rows (${Math.floor(PAGE / 3)} notches)`, forty.steps === Math.floor(PAGE / 3) && forty.end === 40, String(forty.steps))
    const cancelled = coalesceWheelRun(Array.from({ length: 20 }, (_, i) => wheel(i % 2 ? 'wheelup' : 'wheeldown')), 0, PAGE)
    check('a reversal inside one chunk nets to no movement', cancelled.steps === 0 && cancelled.atom === null && cancelled.end === 20)
    const netted = coalesceWheelRun([...Array.from({ length: 5 }, () => wheel('wheelup')), ...Array.from({ length: 2 }, () => wheel('wheeldown'))], 0, PAGE)
    check('five up and two down net to three notches up', netted.steps === 3 && netted.atom?.name === 'wheelup')
    const stopped = coalesceWheelRun([wheel('wheelup'), key('escape'), wheel('wheelup')], 0, PAGE)
    check('a key between two notches ends the gesture', stopped.steps === 1 && stopped.end === 1)
    const parsed = parseMultipleKeypresses(INITIAL_STATE, MOTION + DRAG + '\x1b[<64;10;5M' + '\x1b[<68;10;5M')[0]
    check('motion and drag reports are mouse atoms, not wheel; shift+wheel is still wheel', parsed.length === 4 && parsed[0]!.kind === 'mouse' && parsed[1]!.kind === 'mouse' && parsed[2]!.kind === 'key' && parsed[2]!.name === 'wheelup' && parsed[3]!.kind === 'key' && parsed[3]!.name === 'wheelup', JSON.stringify(parsed.map(a => a.kind === 'key' ? a.name : a.kind)))
  }

  section('§2 the alternate-scroll road and the reported wheel are exclusive by terminal state')
  {
    const arrow = key('up')
    const tracked = resolveAlternateScrollIntent([arrow, wheel('wheelup')], { altScreenActive: true, mouseTrackingEnabled: true, elevatedSurfaceActive: false })
    check('with mouse tracking on, an arrow stays an arrow and a wheel report stays one report', tracked.length === 2 && tracked[0]!.kind === 'key' && tracked[0]!.name === 'up' && tracked[1]!.kind === 'key' && tracked[1]!.name === 'wheelup')
    const untracked = resolveAlternateScrollIntent([arrow, wheel('wheelup')], { altScreenActive: true, mouseTrackingEnabled: false, elevatedSurfaceActive: false })
    check('with mouse tracking off, the terminal-converted arrow becomes a wheel atom without a pointer cell, and nothing is duplicated', untracked.length === 2 && untracked[0]!.kind === 'key' && untracked[0]!.name === 'wheelup' && (untracked[0] as { x?: number }).x === undefined && untracked[1]!.kind === 'key' && untracked[1]!.name === 'wheelup')
    const elevated = resolveAlternateScrollIntent([arrow], { altScreenActive: true, mouseTrackingEnabled: false, elevatedSurfaceActive: true })
    check('an elevated surface keeps the arrow an arrow when tracking is off', elevated[0]!.kind === 'key' && elevated[0]!.name === 'up')
  }

  section('§3 the prompts panel at 120×44 with 70 prompts: bounded travel, no blank rows, no section hop')
  {
    let m = await openPanel()
    check('the panel opens on the newest prompt', selectedPrompt(m) === 'PROMPT_69' && listRows(m).length === 33, m.screen())
    await push(m, WHEEL_UP.repeat(11), 250)
    const rows = listRows(m)
    check('eleven notches up select prompt 58 (one row a notch)', selectedPrompt(m) === 'PROMPT_58', selectedPrompt(m))
    check('every list row the viewport owns paints a prompt (the window follows the viewport, not the selection)', rows.length === 33 && rows.every(line => /PROMPT_\d\d/.test(line)), rows.filter(line => !/PROMPT_\d\d/.test(line)).join('\n') || m.screen())
    for (let n = 0; n < 6; n++) {
      await push(m, WHEEL_UP, 60)
      const live = listRows(m)
      check(`after notch ${n + 12} the list still paints every row`, live.length === 33 && live.every(line => /PROMPT_\d\d/.test(line)), m.screen())
    }
    check('seventeen notches up select prompt 52', selectedPrompt(m) === 'PROMPT_52', selectedPrompt(m))

    m = await openPanel()
    await push(m, WHEEL_UP.repeat(40), 300)
    check(`a forty-notch burst in one chunk moves the selection a page of body rows (${Math.floor(PAGE / 3)} rows), not 40`, selectedPrompt(m) === `PROMPT_${String(69 - Math.floor(PAGE / 3)).padStart(2, '0')}`, selectedPrompt(m))
    check('the frame still paints the whole list after the burst', listRows(m).length === 33 && listRows(m).every(line => /PROMPT_\d\d/.test(line)) && /esc close/.test(m.screen()), m.screen())
    const frameAt = process.argv.indexOf('--frames')
    if (frameAt >= 0 && process.argv[frameAt + 1]) {
      const dir = process.argv[frameAt + 1]!
      mkdirSync(dir, { recursive: true })
      const lines = m.lines()
      const grid = lines.map((line, y) => Array.from(line.padEnd(COLS)).map((c, x) => {
        const style = m.styleAt(x, y)
        return { c, fg: style?.fg.replace(/^#/, ''), bg: style?.bg.replace(/^#/, ''), bold: style?.bold, rev: style?.inverse }
      }))
      const file = join(dir, 'prompts-forty-notch-burst-120x44.grid.json')
      writeFileSync(file, JSON.stringify({ cols: COLS, rows: ROWS, grid }))
      writeFileSync(join(dir, 'prompts-forty-notch-burst-120x44.txt'), lines.join('\n'))
      const { gridToPng } = await import('./gridToPng.js')
      const png = join(dir, 'prompts-forty-notch-burst-120x44.png')
      await gridToPng(file, png)
      console.log(`frame: ${png}`)
    }
    for (let burst = 0; burst < 5; burst++) await push(m, WHEEL_UP.repeat(40), 300)
    check('five more bursts reach the top and clamp there', selectedPrompt(m) === 'PROMPT_00' && listRows(m).length === 33 && listRows(m).every(line => /PROMPT_\d\d/.test(line)), m.screen())

    m = await openPanel()
    await push(m, (WHEEL_DOWN + WHEEL_UP).repeat(20), 250)
    check('twenty reversals in one chunk leave the selection where it was', selectedPrompt(m) === 'PROMPT_69', selectedPrompt(m))
    await push(m, WHEEL_UP.repeat(5) + WHEEL_DOWN.repeat(2), 250)
    check('five up and two down in one chunk move three rows up', selectedPrompt(m) === 'PROMPT_66', selectedPrompt(m))

    m = await openPanel()
    await push(m, WHEEL_DOWN, 200)
    check('a wheel notch past the last prompt stays on the prompts list (it never hops a section)', selectedPrompt(m) === 'PROMPT_69' && /PROMPTS \(70\)/.test(sectionsLine(m) ?? ''), m.screen())
    await push(m, WHEEL_DOWN.repeat(40), 300)
    check('a burst past the last prompt stays there too, with the list painted', selectedPrompt(m) === 'PROMPT_69' && listRows(m).every(line => /PROMPT_\d\d/.test(line)), m.screen())
    await push(m, MOTION.repeat(10) + DRAG.repeat(5), 200)
    check('motion and drag reports move nothing', selectedPrompt(m) === 'PROMPT_69' && listRows(m).length === 33, m.screen())
    await push(m, DOWN, 200)
    check('the down arrow at the last prompt still walks into the next section, as before', /CREW_TRAFFIC_0/.test(m.screen()) && !/PROMPT_69 inspect/.test(listRows(m).join('\n')), m.screen())
    await push(m, UP, 200)
    check('the up arrow at the first traffic row walks back, as before', selectedPrompt(m) === 'PROMPT_69', m.screen())

    boardOn = true
    m = await openPanel()
    await push(m, WHEEL_DOWN.repeat(3), 250)
    check('with the crew board on, a wheel past the last prompt does not swap the panel for the Crew chat', selectedPrompt(m) === 'PROMPT_69' && /Crew chat \(\d+\)/.test(sectionsLine(m) ?? '') && !/BOARD_POST_/.test(m.screen()), m.screen())
    await push(m, DOWN, 300)
    check('the down arrow still opens the Crew chat, as before, on its newest entry', /BOARD_POST_39/.test(m.screen()) && /CREW_TRAFFIC_5/.test(m.lines().find(line => /›/.test(line)) ?? ''), m.screen())
    const crewHeader = m.lines().findIndex(line => /General/.test(line))
    await push(m, WHEEL_UP.repeat(4), 300)
    check('four notches in the Crew chat move its selection four entries (46 entries: 40 posts and 6 traffic rows; the newest traffic row to the second-oldest traffic row) and nothing else: the header row stays put and the panel paints', m.lines().findIndex(line => /General/.test(line)) === crewHeader && /CREW_TRAFFIC_1\b/.test(m.lines().find(line => /›/.test(line)) ?? '') && /BOARD_POST_/.test(m.screen()), `header ${crewHeader} -> ${m.lines().findIndex(line => /General/.test(line))}; selected: ${m.lines().find(line => /›/.test(line))}\n${m.screen()}`)
    boardOn = false

    m = await openPanel()
    await push(m, '3', 200)
    const emptyBefore = m.screen()
    await push(m, WHEEL_UP.repeat(3) + WHEEL_DOWN.repeat(2), 250)
    check('a wheel over an empty saved-prompts list changes nothing and paints the hint', m.screen() === emptyBefore && /no saved prompts yet/.test(m.screen()), m.screen())
    mounted?.unmount()
    mounted = undefined
  }

  section('§4 the real chat screen: the workbench over the transcript, then the transcript again')
  {
    const m = await mountOffscreen(
      h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))),
      COLS,
      ROWS,
      { mouseTracking: true },
    )
    mounted = m
    await waitFor(() => composerRow(m).includes('Type a prompt'), 8000)
    await settle(400)
    const transcriptBefore = transcriptRows(m)
    check('the chat painted transcript rows', transcriptBefore.length > 0, m.screen())
    await push(m, WHEEL_UP.repeat(40), 600)
    const transcriptScrolled = transcriptRows(m)
    check('a forty-notch burst scrolls the transcript and leaves it painted', JSON.stringify(transcriptScrolled) !== JSON.stringify(transcriptBefore) && transcriptScrolled.length > 0, m.screen())
    const topRow = transcriptScrolled[0]!.match(/\d\d/)![0]
    check(`the burst moved the transcript by at most a page (top row ${topRow})`, Number(topRow) >= 69 - PAGE / 2 - 1, m.screen())

    for (const ch of '/workbench') await push(m, ch, 30)
    await push(m, '\r', 200)
    await waitFor(() => /PROMPTS \(70\)/.test(m.screen()), 6000)
    await settle(400)
    check('the workbench opened over the transcript on the newest prompt', selectedPrompt(m) === 'PROMPT_69', m.screen())
    await push(m, WHEEL_UP.repeat(40), 800)
    check(`the burst moves the workbench selection a page of body rows (${Math.floor(PAGE / 3)} rows) and the list stays painted`, selectedPrompt(m) === `PROMPT_${String(69 - Math.floor(PAGE / 3)).padStart(2, '0')}` && listRows(m).length === 33 && listRows(m).every(line => /PROMPT_\d\d/.test(line)), m.screen())
    await push(m, (WHEEL_DOWN + WHEEL_UP).repeat(10), 400)
    check('reversals leave the workbench selection and paint alone', selectedPrompt(m) === `PROMPT_${String(69 - Math.floor(PAGE / 3)).padStart(2, '0')}` && listRows(m).length === 33, m.screen())
    await push(m, WHEEL_DOWN.repeat(40), 800)
    await push(m, WHEEL_DOWN.repeat(5), 400)
    check('a burst past the newest prompt stays on the workbench prompts list', selectedPrompt(m) === 'PROMPT_69' && /PROMPTS \(70\)/.test(m.screen()), m.screen())
    await push(m, '\x1b', 600)
    check('esc closes the workbench and the transcript is exactly where the wheel left it before the workbench opened', !/PROMPTS \(70\)/.test(m.screen()) && JSON.stringify(transcriptRows(m)) === JSON.stringify(transcriptScrolled), `${JSON.stringify(transcriptScrolled.slice(0, 4))} -> ${JSON.stringify(transcriptRows(m).slice(0, 4))}`)
    await push(m, WHEEL_DOWN.repeat(10), 600)
    check('after esc the wheel reaches the transcript again and it stays painted', JSON.stringify(transcriptRows(m)) !== JSON.stringify(transcriptScrolled) && transcriptRows(m).length > 0, m.screen())
  }
} finally {
  mounted?.unmount()
  slot.releaseFocusedSessionConnector()
  await releaseScratchHome(HOME)
}
console.log(`wheel-hardening: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
