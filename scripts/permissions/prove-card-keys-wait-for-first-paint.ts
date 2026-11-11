#!/usr/bin/env bun
import React from 'react'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('card-keys-first-paint')
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
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { registerComposerSeeder } = await import('../../src/utils/cockpit/composerSeed.ts')
const { _resetInterviewForProofs } = await import('../../src/services/interview/store.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const h = React.createElement
type Named = { name: string }
const roster = getAllBaseTools() as unknown as Named[]
const toolOf = (name: string): unknown => roster.find(tool => tool.name === name)

let painter: { pause: () => void; resume: () => void } | undefined
function Painter(): null {
  painter = React.useContext(InkInstanceContext) as typeof painter
  return null
}

function contextOf(): unknown {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: roster, commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), messages: [], readFileState: new Map(), toolUseId: 'toolu_card',
    getAppState: () => state, setAppState: () => undefined, setResponseLength: () => undefined, updateFileHistoryState: () => undefined, updateAttributionState: () => undefined,
  }
}

type Answers = { allowed: unknown[][]; rejected: number; done: number }
let raise: ((card: React.ReactNode) => void) | null = null
function Host(): React.ReactNode {
  const [card, setCard] = React.useState<React.ReactNode>(null)
  raise = setCard
  return card
}

let cardNumber = 0
function cardOf(name: string, input: Record<string, unknown>, answers: Answers): React.ReactNode {
  const context = contextOf()
  const confirm = {
    tool: toolOf(name), input, toolUseID: `toolu_card_${++cardNumber}`, description: `${name} card`, toolUseContext: context,
    permissionResult: { behavior: 'ask', message: `Mercury wants to use ${name}` }, assistantMessage: { type: 'assistant', uuid: 'card-assistant', message: { id: 'msg_card', role: 'assistant', content: [] } },
    permissionPromptStartTimeMs: Date.now(), onAllow: (...args: unknown[]) => { answers.allowed.push(args) }, onReject: () => { answers.rejected++ }, onAbort: () => {}, onUserInteraction: () => {}, recheckPermission: async () => {},
  }
  return h(PermissionRequest, { toolUseConfirm: confirm, toolUseContext: context, onDone: () => { answers.done++ }, onReject: () => {}, verbose: false, workerBadge: undefined } as never)
}
async function stage(): Promise<Mounted> {
  _resetInterviewForProofs()
  const view = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(Painter), h(Host))), 110, 34)
  await settle(250)
  return view
}
function markOf(view: Mounted): number {
  for (const line of view.lines()) {
    const mark = /❯\s*(\d)\./.exec(line)
    if (mark) return Number(mark[1])
  }
  return 0
}
async function press(view: Mounted, data: string, wait = 160): Promise<void> {
  view.push(data)
  await settle(wait)
}
const fresh = (): Answers => ({ allowed: [], rejected: 0, done: 0 })
const SHELL = { command: 'echo "one" >> notes.log', description: 'Append a line' }
const option = (label: string, description: string): Record<string, string> => ({ label, description })
const QUESTION = { questions: [{ question: 'Which engine?', header: 'Engine', multiSelect: false, options: [option('Redis', 'Shared.'), option('Memory', 'Local.'), option('File', 'Durable.')] }] }

const seeds: string[] = []
const unregister = registerComposerSeeder((seed: string) => { seeds.push(seed) })

section('a shell command\'s card that is mounted and not yet painted takes no answer')
{
  const view = await stage()
  const answers = fresh()
  try {
    painter!.pause()
    raise!(cardOf('Bash', SHELL, answers))
    await settle(250)
    check('the card is mounted and its frame has not been written', markOf(view) === 0 && !view.lines().some(line => line.includes('notes.log')), view.lines().filter(line => line.trim() !== '').slice(-6).join(' | '))
    await press(view, '1')
    check('the digit 1 typed before the first frame does not answer Yes', answers.allowed.length === 0 && answers.done === 0, `allowed ${answers.allowed.length}, done ${answers.done}`)
    await press(view, KEY.enter)
    check('↵ typed before the first frame does not answer', answers.allowed.length === 0 && answers.rejected === 0 && answers.done === 0, `allowed ${answers.allowed.length}, rejected ${answers.rejected}, done ${answers.done}`)
    await press(view, '2')
    await press(view, KEY.down)
    check('the wider grant\'s digit and ↓ do nothing there either', answers.allowed.length === 0 && answers.done === 0, `allowed ${answers.allowed.length}`)
    const before = seeds.length
    await press(view, 'w')
    check('a letter typed there still goes to the composer, as it does on a painted card', seeds.length === before + 1 && seeds.at(-1) === 'w' && answers.allowed.length === 0, `seeds ${JSON.stringify(seeds.slice(before))}`)
    painter!.resume()
    const painted = await waitFor(() => markOf(view) === 1, 5_000)
    check('the first frame paints the card with its mark on the first row: the held ↓ moved nothing', painted, `mark on row ${markOf(view)}`)
    await press(view, '1')
    check('the digit 1 typed after the first frame answers Yes, once', answers.allowed.length === 1 && answers.done === 1, `allowed ${answers.allowed.length}, done ${answers.done}`)
  } finally {
    view.unmount()
  }
}

section('Esc before the first frame still declines')
{
  const view = await stage()
  const answers = fresh()
  try {
    painter!.pause()
    raise!(cardOf('Bash', SHELL, answers))
    await settle(250)
    await press(view, KEY.esc, 400)
    check('Esc typed before the first frame declines the call', answers.rejected === 1 && answers.allowed.length === 0, `rejected ${answers.rejected}, allowed ${answers.allowed.length}`)
    painter!.resume()
  } finally {
    view.unmount()
  }
}

section('a question card: a digit typed before its first frame picks nothing')
{
  const view = await stage()
  const answers = fresh()
  try {
    painter!.pause()
    raise!(cardOf('AskUserQuestion', QUESTION, answers))
    await settle(250)
    await press(view, '2')
    await press(view, KEY.enter)
    check('2 and ↵ typed before the first frame answer nothing', answers.allowed.length === 0 && answers.done === 0, `allowed ${answers.allowed.length}, done ${answers.done}`)
    painter!.resume()
    const painted = await waitFor(() => markOf(view) === 1, 5_000)
    check('the question paints with its mark on the first option', painted, `mark on row ${markOf(view)}`)
    await press(view, '2')
    const answered = await waitFor(() => answers.allowed.length === 1, 3_000)
    check('2 typed after the first frame answers with the second option', answered && JSON.stringify(answers.allowed[0]).includes('Memory'), JSON.stringify(answers.allowed).slice(0, 300))
  } finally {
    view.unmount()
  }
}

section('a card painted in the ordinary order answers at once')
{
  const view = await stage()
  const answers = fresh()
  try {
    raise!(cardOf('Write', { file_path: join(home, 'b.txt'), content: 'hello\n' }, answers))
    const painted = await waitFor(() => markOf(view) === 1, 5_000)
    view.push('1')
    await settle(160)
    check('1 pushed as soon as the card\'s frame is read answers Yes', painted && answers.allowed.length === 1, `painted ${painted}, allowed ${answers.allowed.length}`)
  } finally {
    view.unmount()
  }
}

unregister()
_resetInterviewForProofs()
await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
