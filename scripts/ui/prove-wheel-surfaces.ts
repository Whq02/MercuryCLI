import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, pinSourceRef, type Mounted } from '../lib/settingsPopupHarness.js'
import type { BoardViewSnapshot } from '../../src/services/crewBoard/contracts.js'
import type { ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'
import type { SessionListing } from '../../src/types/logs.js'

pinSourceRef()
const home = pinScratchHome('wheel-surfaces')
writeFileSync(join(home, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
process.env.MERCURY_OPERATOR = 'operator'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const React = await import('react')
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { PromptsPanel } = await import('../../src/components/prompts-panel/PromptsPanel.js')
const { CrewChatPanel } = await import('../../src/components/prompts-panel/CrewChatPanel.js')
const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.js')
const { addSavedPrompt } = await import('../../src/utils/savedPrompts/savedPromptsStore.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { LogSelector } = await import('../../src/components/LogSelector.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.js')
const { Messages } = await import('../../src/components/Messages.js')
const { default: TextInput } = await import('../../src/components/TextInput.js')
const { useElevatedSurface } = await import('../../src/components/mercury-ui/useElevatedSurface.js')

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const WHEEL_UP = '\x1b[<64;10;5M'
const WHEEL_DOWN = '\x1b[<65;10;5M'
const h = React.createElement
const noop = (): void => {}
const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString()
const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'wheel fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
connector.workspace = () => ({ cwd: home, projectRoot: home }) as ReturnType<typeof connector.workspace>
let boardOn = false
const board: BoardViewSnapshot = {
  on: true, snapshot: 40, omitted: 0, admitted: 40, peerTurns: 0,
  events: Array.from({ length: 40 }, (_, i) => ({
    schema: 1, boardId: 'fixture', waveId: 'fixture', seq: i + 1, eventId: `event-${i}`, clientOpId: `post-${i}`, kind: 'result', author: { sessionId: 'fixture', agentId: `crew-${i % 3}`, executionId: 'fixture' }, authorName: `crew-${i % 3}`, mentions: [], relatedTasks: [], files: [], refs: [], createdAt: at(i), payloadDigest: '', threadId: i < 20 ? `thread-${i}` : 'thread-long', policyRevision: 1,
    text: `BOARD_POST_${String(i).padStart(2, '0')}\n${Array.from({ length: 20 }, (_, line) => `Thread detail line ${line}`).join('\n')}`,
  })),
}
connector.swarmBoard = () => boardOn ? board : null
for (let i = 0; i < 36; i++) {
  connector.addDisplayRow({ ...createUserMessage({ content: `PROMPT_${String(i).padStart(2, '0')} inspect the selected module` }), timestamp: at(i) })
  connector.addDisplayRow({ ...createUserMessage({ content: `<crewmate-message crewmate_id="crew-${i}" summary="row ${i}">CREW_TRAFFIC_${i}</crewmate-message>` }), timestamp: at(i) })
  await addSavedPrompt(home, `SAVED_PROMPT_${String(i).padStart(2, '0')}`)
}
setFocusedSessionConnector(connector)
const models = Array.from({ length: 20 }, (_, i) => ({ id: `fixture-model-${i}`, name: `Fixture ${i}`, tag: '', ctx: '128k ctx', group: 'Fixture' }))
const logs: SessionListing[] = Array.from({ length: 24 }, (_, i) => ({ date: at(i), value: i, firstPrompt: `SESSION_${String(i).padStart(2, '0')}`, customTitle: `SESSION_${String(i).padStart(2, '0')}`, isSidechain: false, messages: [], created: new Date(at(i)), modified: new Date(at(i)), sessionId: randomUUID(), messageCount: 2 }))
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
let mounted: Mounted | undefined
let scene = 0
async function open(body: React.ReactNode): Promise<Mounted> {
  const element = h(AppStateProvider, { children: h(KeybindingSetup, { children: h(Box, { key: ++scene, width: 120, height: 44, flexDirection: 'column' }, body) }) })
  if (mounted) mounted.resize(element, 120, 44)
  else mounted = await mountOffscreen(element, 120, 44, { mouseTracking: true })
  await settle(180)
  return mounted
}
const shot = (m: Mounted): string => JSON.stringify([m.screen(), m.cursor()])
async function equivalent(name: string, body: () => React.ReactNode, setup: string, direction: 'up' | 'down', notches = 1): Promise<Mounted> {
  const wheel = direction === 'up' ? WHEEL_UP : WHEEL_DOWN
  const arrow = direction === 'up' ? UP : DOWN
  let m = await open(body())
  if (setup) { m.push(setup); await settle(100) }
  const before = shot(m)
  m.push(arrow.repeat(3 * notches))
  await settle(100)
  const expected = shot(m)
  check(`${name}: three arrows per notch move the surface`, before !== expected)
  m = await open(body())
  if (setup) { m.push(setup); await settle(100) }
  m.push(wheel.repeat(notches))
  await settle(100)
  check(`${name}: SGR wheel matches ${3 * notches} arrow presses`, shot(m) === expected, m.screen())
  return m
}

try {
  const prompts = await equivalent('prompts list, three notches', () => h(PromptsPanel, { onClose: noop }), '', 'up', 3)
  const frameAt = process.argv.indexOf('--frames')
  if (frameAt >= 0 && process.argv[frameAt + 1]) {
    const dir = process.argv[frameAt + 1]!
    mkdirSync(dir, { recursive: true })
    const lines = prompts.lines()
    const grid = lines.map((line, y) => Array.from(line.padEnd(120)).map((c, x) => {
      const style = prompts.styleAt(x, y)
      return { c, fg: style?.fg.replace(/^#/, ''), bg: style?.bg.replace(/^#/, ''), bold: style?.bold, rev: style?.inverse }
    }))
    const file = join(dir, 'prompts-three-wheel-notches-120x44.grid.json')
    writeFileSync(file, JSON.stringify({ cols: 120, rows: 44, grid }))
    writeFileSync(join(dir, 'prompts-three-wheel-notches-120x44.txt'), lines.join('\n'))
    const { gridToPng } = await import('./gridToPng.js')
    const png = join(dir, 'prompts-three-wheel-notches-120x44.png')
    await gridToPng(file, png)
    console.log(`frame: ${png}`)
  }
  await equivalent('crew traffic list', () => h(PromptsPanel, { onClose: noop }), '2', 'down')
  await equivalent('saved prompts list', () => h(PromptsPanel, { onClose: noop }), '3', 'down')
  await equivalent('Crew chat', () => h(CrewChatPanel, { snapshot: board, traffic: [], onClose: noop, onSection: noop }), '', 'up')
  await equivalent('Crew chat detail', () => h(CrewChatPanel, { snapshot: board, traffic: [], onClose: noop, onSection: noop }), '\r', 'down')
  boardOn = true
  await equivalent('CrewView Board tab', () => h(CrewView, { onClose: noop }), '\t', 'up')
  boardOn = false
  await equivalent('sessions list', () => h(LogSelector, { logs, onSelect: noop, onCancel: noop, maxHeight: 30 }), '', 'down')
  await equivalent('model picker', () => h(MercuryModelPicker, { models, current: models[0]!.id, ctxPct: null, onClose: noop }), '', 'down')

  async function config(): Promise<Mounted> {
    popup.closeSettingsPopup()
    const m = await open(h(SettingsPopupSlot, { overlay: true }))
    popup.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
    await settle(200)
    return m
  }
  let m = await config()
  const configBefore = shot(m)
  m.push(DOWN.repeat(3))
  await settle(100)
  const configExpected = shot(m)
  check('/config: three arrows move the selected row', configBefore !== configExpected)
  m = await config()
  m.push(WHEEL_DOWN)
  await settle(100)
  check('/config: the wheel selects the same row as three arrows', shot(m) === configExpected, m.screen())
  popup.closeSettingsPopup()

  const scroll = React.createRef<ScrollBoxHandle>()
  const background = React.createRef<ScrollBoxHandle>()
  let composerEdits = 0
  let historyMoves = 0
  const transcript = Array.from({ length: 50 }, (_, i) => createAssistantMessage({ content: `TRANSCRIPT_ROW_${i}` }))
  function Body({ chat = false, covered = false }: { chat?: boolean; covered?: boolean }): React.ReactNode {
    const elevated = useElevatedSurface()
    return h(Box, { flexDirection: 'column' },
      covered ? h(ScrollBox, { ref: background, height: 5, flexDirection: 'column' }, h(Text, {}, Array.from({ length: 60 }, (_, i) => `BACKGROUND_${i}`).join('\n'))) : null,
      h(Box, { ref: covered ? elevated : undefined, flexDirection: 'column' },
        h(ScrollBox, { ref: scroll, height: 12, flexDirection: 'column' }, chat
          ? h(Messages, { messages: transcript, tools: [], verbose: false, toolJSX: null, toolUseConfirmQueue: [], inProgressToolUseIDs: new Set<string>(), isMessageSelectorVisible: false, conversationId: 'wheel-fixture', screen: 'prompt', streamingToolUses: [], isLoading: false, suppressLogo: true, suppressNotices: true, scrollRef: scroll })
          : h(Text, {}, Array.from({ length: 60 }, (_, i) => `BODY_ROW_${i}`).join('\n')))),
      chat ? h(TextInput, { value: 'composer draft', columns: 120, onChange: () => { composerEdits++ }, onSubmit: noop, cursorOffset: 14, onChangeCursorOffset: noop, onHistoryUp: () => { historyMoves++ }, onHistoryDown: () => { historyMoves++ }, focus: true, showCursor: true }) : null,
      chat ? h(ScrollKeybindingHandler, { scrollRef: scroll, isActive: true }) : null,
      covered ? h(ScrollKeybindingHandler, { scrollRef: background, isActive: true }) : null)
  }
  for (const [name, chat, covered] of [['ScrollBox', false, false], ['transcript', true, false], ['elevated ScrollBox', false, true]] as const) {
    m = await open(h(Body, { chat, covered }))
    scroll.current!.scrollTo(12)
    await settle(100)
    m.push(WHEEL_DOWN)
    await settle(100)
    check(`${name}: one wheel-down notch scrolls three rows`, scroll.current!.getScrollTop() === 15, String(scroll.current!.getScrollTop()))
    m.push(WHEEL_UP)
    await settle(100)
    check(`${name}: one wheel-up notch scrolls three rows without a lost reversal`, scroll.current!.getScrollTop() === 12, String(scroll.current!.getScrollTop()))
    m.push('\x1b[<64;')
    await settle(5)
    m.push('10;5M')
    await settle(100)
    check(`${name}: a split SGR report also scrolls three rows`, scroll.current!.getScrollTop() === 9)
    scroll.current!.scrollTo(0)
    await settle(80)
    m.push(WHEEL_UP)
    await settle(80)
    check(`${name}: scrolling at the top stays clamped`, scroll.current!.getScrollTop() === 0)
    if (covered) check('the covered ScrollBox did not move', background.current!.getScrollTop() === 0)
    if (chat) check('the wheel neither edits the composer nor walks prompt history', composerEdits === 0 && historyMoves === 0)
  }
} finally {
  mounted?.unmount()
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`wheel-surfaces: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
