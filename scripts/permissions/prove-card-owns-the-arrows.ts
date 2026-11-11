#!/usr/bin/env bun
import React from 'react'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('card-owns-the-arrows')
Object.assign(process.env, { MERCURY_FULLSCREEN: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true' })
for (const key of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER']) delete process.env[key]

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { PermissionRequest } = await import('../../src/components/permissions/PermissionRequest.tsx')
const { InkInstanceContext } = await import('../../src/ink/components/InkInstanceContext.ts')
const { resolveAlternateScrollIntent } = await import('../../src/ink/termio/alternateScrollPolicy.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { _resetInterviewForProofs } = await import('../../src/services/interview/store.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const h = React.createElement
type Named = { name: string }
const roster = getAllBaseTools() as unknown as Named[]
const toolOf = (name: string): unknown => roster.find(tool => tool.name === name) ?? [PowerShellTool as unknown as Named, ComputerTool as unknown as Named].find(tool => tool.name === name)
const WHEEL_UP = '\x1b[<64;10;5M'
const ARROWS = [{ kind: 'key', name: 'up' }, { kind: 'key', name: 'down' }]
const WINDOWS_BEFORE_A_WHEEL_REPORT = { altScreenActive: true, mouseTrackingEnabled: true, elevatedSurfaceActive: false, platform: 'win32', wheelReportingConfirmed: false, scrollableTranscript: true }

let painter: { arrowKeysOwned?: () => boolean } | undefined
function Painter(): null {
  painter = React.useContext(InkInstanceContext) as typeof painter
  return null
}
const owned = (): boolean => painter?.arrowKeysOwned?.() === true
const asWindowsReads = (): string =>
  resolveAlternateScrollIntent(ARROWS as never, { ...WINDOWS_BEFORE_A_WHEEL_REPORT, arrowKeysOwned: painter?.arrowKeysOwned?.() } as never).map(atom => (atom as Named).name).join(',')

function contextOf(): unknown {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: roster, commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), messages: [], readFileState: new Map(), toolUseId: 'toolu_card',
    getAppState: () => state, setAppState: () => undefined, setResponseLength: () => undefined, updateFileHistoryState: () => undefined, updateAttributionState: () => undefined,
  }
}

let cardNumber = 0
async function cardUp(name: string, input: Record<string, unknown>, mouseTracking = false): Promise<Mounted> {
  _resetInterviewForProofs()
  const context = contextOf()
  const confirm = {
    tool: toolOf(name), input, toolUseID: `toolu_card_${++cardNumber}`, description: `${name} card`, toolUseContext: context,
    permissionResult: { behavior: 'ask', message: `Mercury wants to use ${name}` }, assistantMessage: { type: 'assistant', uuid: 'card-assistant', message: { id: 'msg_card', role: 'assistant', content: [] } },
    permissionPromptStartTimeMs: Date.now(), onAllow: () => {}, onReject: () => {}, onAbort: () => {}, onUserInteraction: () => {}, recheckPermission: async () => {},
  }
  const view = await mountOffscreen(
    h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(Painter), h(PermissionRequest, { toolUseConfirm: confirm, toolUseContext: context, onDone: () => {}, onReject: () => {}, verbose: false, workerBadge: undefined } as never))),
    110, 34, mouseTracking ? { mouseTracking: true } : undefined,
  )
  await waitFor(() => markOf(view) !== 0, 8_000)
  await settle(300)
  return view
}
function markOf(view: Mounted): number {
  for (const line of view.lines()) {
    const mark = /❯\s*(\d)\./.exec(line)
    if (mark) return Number(mark[1])
  }
  return 0
}
async function press(view: Mounted, data: string): Promise<number> {
  view.push(data)
  await settle(200)
  return markOf(view)
}

const option = (label: string, description: string, preview?: string): Record<string, string> => ({ label, description, ...(preview === undefined ? {} : { preview }) })
const ONE_ANSWER = { questions: [{ question: 'Which engine?', header: 'Engine', multiSelect: false, options: [option('Redis', 'Shared.'), option('Memory', 'Local.'), option('File', 'Durable.')] }] }
const SEVERAL_ANSWERS = { questions: [{ question: 'Which checks?', header: 'Checks', multiSelect: true, options: [option('Lint', 'Style.'), option('Types', 'Compiler.'), option('Tests', 'Suites.')] }] }
const WITH_PREVIEWS = { questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [option('Rows', 'Stacked.', 'row one\nrow two'), option('Columns', 'Side by side.', 'col one | col two')] }] }
const CARDS: Array<[string, string, Record<string, unknown>]> = [
  ['a shell command', 'Bash', { command: 'echo "one" >> notes.log', description: 'Append a line' }],
  ['a PowerShell command', 'PowerShell', { command: 'Get-ChildItem', description: 'List the folder' }],
  ['a fetch', 'WebFetch', { url: 'https://example.com/page', prompt: 'read it' }],
  ['an edit', 'Edit', { file_path: join(home, 'a.txt'), old_string: 'a', new_string: 'b' }],
  ['a write', 'Write', { file_path: join(home, 'b.txt'), content: 'hello\n' }],
  ['a read outside the project', 'Read', { file_path: '/etc/hosts' }],
  ['a Git action', 'Git', { action: 'stage', paths: ['a.txt'] }],
  ['a skill', 'Skill', { skill: 'loop' }],
  ['a Computer action', 'Computer', { action: 'screenshot' }],
  ['a Browser action', 'Browser', { action: 'open', url: 'https://example.com' }],
  ['a notebook edit', 'NotebookEdit', { notebook_path: join(home, 'n.ipynb'), new_source: 'x', cell_id: '1' }],
  ['a question with one answer', 'AskUserQuestion', ONE_ANSWER],
  ['a question with several answers', 'AskUserQuestion', SEVERAL_ANSWERS],
  ['a question with previews', 'AskUserQuestion', WITH_PREVIEWS],
]

section('a card that is up owns the arrows, and gives them back when it leaves')
{
  const notOwned: string[] = []
  const kept: string[] = []
  const asWheel: string[] = []
  const stuck: string[] = []
  for (const [label, name, input] of CARDS) {
    if (toolOf(name) === undefined) {
      stuck.push(`${label}: no tool named ${name}`)
      continue
    }
    const view = await cardUp(name, input)
    try {
      const opened = markOf(view)
      if (!owned()) notOwned.push(label)
      if (asWindowsReads() !== 'up,down') asWheel.push(`${label}: ${asWindowsReads()}`)
      const moved = await press(view, KEY.down)
      if (opened !== 1 || moved !== 2) stuck.push(`${label}: the mark on row ${opened}, after ↓ on row ${moved}`)
    } finally {
      view.unmount()
    }
    await settle(80)
    if (owned()) kept.push(label)
  }
  check(`each of the ${CARDS.length} cards, while it is up: the painter says the arrows are owned`, notOwned.length === 0, `not owned under: ${notOwned.join(', ')}`)
  check('…so Windows before its first wheel report reads ↑ and ↓ as arrows there', asWheel.length === 0, asWheel.join(' · '))
  check('mouse tracking off, each card: ↓ moves the mark from its first row to its second', stuck.length === 0, stuck.join(' · '))
  check('each card gone: nobody owns the arrows, and they are read as wheel steps again', kept.length === 0 && !owned() && asWindowsReads() === 'wheelup,wheeldown', `still owned after: ${kept.join(', ')} · ${asWindowsReads()}`)
}

section('mouse tracking off, the question card: every row is reached by the arrows')
{
  const view = await cardUp('AskUserQuestion', ONE_ANSWER)
  try {
    const walk = [await press(view, KEY.down), await press(view, KEY.down), await press(view, KEY.down), await press(view, KEY.down)]
    const onChat = view.lines().some(line => /❯\s*5\.\s*Chat about this/.test(line))
    check('↓ four times walks the options, the row for the operator\'s own words and reaches `Chat about this`', walk.join(',') === '2,3,4,5' && onChat, `rows ${walk.join(',')}`)
    const back = await press(view, KEY.up)
    check('↑ from there returns to the list', back === 4, `row ${back}`)
  } finally {
    view.unmount()
  }
  const several = await cardUp('AskUserQuestion', SEVERAL_ANSWERS)
  try {
    const down = await press(several, KEY.down)
    const downAgain = await press(several, KEY.down)
    const up = await press(several, KEY.up)
    check('several answers: ↓ ↓ ↑ walks the mark to the second, the third and back to the second row', `${down},${downAgain},${up}` === '2,3,2', `rows ${down},${downAgain},${up}`)
  } finally {
    several.unmount()
  }
  const previews = await cardUp('AskUserQuestion', WITH_PREVIEWS)
  try {
    const down = await press(previews, KEY.down)
    const up = await press(previews, KEY.up)
    check('previews: ↓ moves to the second option and ↑ back to the first', `${down},${up}` === '2,1', `rows ${down},${up}`)
  } finally {
    previews.unmount()
  }
}

section('a wheel the terminal reports is still not the card\'s')
{
  const view = await cardUp('Bash', { command: 'echo "two" >> notes.log', description: 'Append a line' }, true)
  try {
    const notch = await press(view, WHEEL_UP)
    const arrow = await press(view, KEY.down)
    check('mouse tracking on, the shell command\'s card: a notch leaves the mark on its first row, ↓ moves it', notch === 1 && arrow === 2 && owned(), `after the notch row ${notch}, after ↓ row ${arrow}`)
  } finally {
    view.unmount()
  }
}

_resetInterviewForProofs()
await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
