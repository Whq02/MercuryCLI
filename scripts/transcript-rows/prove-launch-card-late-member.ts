#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const ROOT = resolve(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'launch-card-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.MERCURY_HOME

const src = (rel: string): string => join(ROOT, 'src', rel)
const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default as typeof import('react')
const { default: Ink } = await import(src('ink/ink.tsx'))
const { App } = await import(src('components/App.tsx'))
const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
const { KeybindingSetup } = await import(src('keybindings/KeybindingProviderSetup.tsx'))
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import(src('context/surfaceRoute.ts'))
const { enableConfigs, saveCurrentProjectConfig } = await import(src('utils/config.ts'))
const { default: instances } = await import(src('ink/instances.ts'))
const { Messages } = await import(src('components/Messages.tsx'))
const { areMessageRowPropsEqual } = await import(src('components/MessageRow.tsx'))
const { applyGrouping } = await import(src('utils/groupToolUses.ts'))
const { buildMessageLookups } = await import(src('utils/messages/lookups.ts'))
const { normalizeMessages } = await import(src('utils/messages/normalize.ts'))
const { getTools } = await import(src('tools.ts'))
const { AgentTool } = await import(src('tools/AgentTool/AgentTool.tsx'))
const { AGENT_TOOL_NAME } = await import(src('tools/AgentTool/constants.ts'))
const { BashTool } = await import(src('tools/BashTool/BashTool.tsx'))

enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const h = React.createElement
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(20)
  }
  return pred()
}
const hardLimit = setTimeout(() => {
  console.error('prove-launch-card-late-member exceeded its deadline')
  process.exit(1)
}, 120_000)
hardLimit.unref()

type Rec = Record<string, unknown>
const STATIONS = ['a', 'b', 'c', 'd'] as const
type Station = (typeof STATIONS)[number]
const iso = (at: number): string => new Date(at).toISOString()
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const uuidAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const assistantRec = (n: number, at: number, apiId: string, content: unknown[]): Rec => ({
  type: 'assistant',
  uuid: uuidAt(n),
  timestamp: iso(at),
  requestId: `req_${n}`,
  message: { id: apiId, type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: 'tool_use', stop_sequence: null, usage },
})
const userRec = (n: number, at: number, content: unknown, extra: Rec = {}): Rec => ({
  type: 'user',
  uuid: uuidAt(n),
  timestamp: iso(at),
  message: { role: 'user', content },
  ...extra,
})

type Scene = {
  prompt: Rec
  words: Rec
  launch: Record<Station, Rec>
  launched: Record<Station, Rec>
  refused: Rec
  renamed(label: string): Rec
  shell: Rec
  shellDone: Rec
  ids: Record<Station, string>
  shellId: string
}
function sceneRecords(base: number, apiId: string, t0: number): Scene {
  const idOf = (s: Station): string => `toolu_${apiId}_${s}`
  const launchOf = (n: number, s: Station, label: string): Rec =>
    assistantRec(n, t0 + 1_000, apiId, [{ type: 'tool_use', id: idOf(s), name: AGENT_TOOL_NAME, input: { description: label, prompt: `survey station ${s} and report in one line`, crewmate_type: 'mercury-crew', run_in_background: true } }])
  const launchedOf = (n: number, s: Station): Rec =>
    userRec(n, t0 + 2_000, [{ type: 'tool_result', tool_use_id: idOf(s), content: [{ type: 'text', text: `Async agent launched: seat-${s}` }] }], {
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: `agent-${apiId}-${s}`, description: `seat-${s}`, prompt: `survey station ${s} and report in one line`, outputFile: join(PROJECT, `${apiId}-${s}.output`), canReadOutputFile: true },
    })
  const shellId = `toolu_${apiId}_shell`
  return {
    prompt: userRec(base, t0, 'launch the survey'),
    words: assistantRec(base + 1, t0 + 1_000, apiId, [{ type: 'text', text: 'launching the survey' }]),
    launch: { a: launchOf(base + 2, 'a', 'seat-a'), b: launchOf(base + 3, 'b', 'seat-b'), c: launchOf(base + 4, 'c', 'seat-c'), d: launchOf(base + 5, 'd', 'seat-d') },
    launched: { a: launchedOf(base + 6, 'a'), b: launchedOf(base + 7, 'b'), c: launchedOf(base + 8, 'c'), d: launchedOf(base + 9, 'd') },
    refused: userRec(base + 9, t0 + 2_000, [{ type: 'tool_result', tool_use_id: idOf('d'), content: 'the launch of seat-d was refused', is_error: true }], { toolUseResult: 'Error: the launch of seat-d was refused' }),
    renamed: label => launchOf(base + 5, 'd', label),
    shell: assistantRec(base + 10, t0 + 1_000, apiId, [{ type: 'tool_use', id: shellId, name: 'Bash', input: { command: 'sleep 600', description: 'a long call beside the launches' } }]),
    shellDone: userRec(base + 11, t0 + 3_000, [{ type: 'tool_result', tool_use_id: shellId, content: 'done' }], { toolUseResult: { stdout: 'done', stderr: '', interrupted: false, isImage: false } }),
    ids: { a: idOf('a'), b: idOf('b'), c: idOf('c'), d: idOf('d') },
    shellId,
  }
}

class Output extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
  write(): boolean {
    return true
  }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this {
    return this
  }
  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  read(): string | null {
    return null
  }
  get readableLength(): number {
    return 0
  }
}

const tools = [...getTools(getDefaultAppState().toolPermissionContext).filter(t => t.name !== AGENT_TOOL_NAME && t.name !== 'Bash'), AgentTool, BashTool]
type Stage = { records: Rec[]; running: Set<string> }
type Screen = { set(records: Rec[], running: string[]): void; frame(): string; lines(): string[]; close(): Promise<void> }
async function mount(first: Stage): Promise<Screen> {
  let stage = first
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
  const read = (): Stage => stage
  function Harness(): React.ReactNode {
    const now = React.useSyncExternalStore(subscribe, read, read)
    return h(
      KeybindingSetup,
      null,
      h(Messages as never, {
        messages: now.records,
        tools,
        commands: [],
        verbose: false,
        toolJSX: null,
        toolUseConfirmQueue: [],
        inProgressToolUseIDs: now.running,
        isMessageSelectorVisible: false,
        conversationId: 'launch-card',
        screen: 'prompt',
        streamingToolUses: [],
        isLoading: now.running.size > 0,
        suppressLogo: true,
      } as never),
    )
  }
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  const stdout = new Output(140, 44)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(140, 44) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: { ...getDefaultAppState(), expandedView: 'none' }, getFpsMetrics: () => undefined }, h(Harness)))
  const frame = (): string => stripAnsi(ink.lastFrameText())
  return {
    set: (records, running) => {
      stage = { records, running: new Set(running) }
      for (const l of listeners) l()
    },
    frame,
    lines: () => frame().split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== ''),
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}
const cardHeads = (lines: string[]): string[] => lines.filter(l => /background crewmates launched/.test(l)).map(l => /(\d+ background crewmates launched)/.exec(l)?.[1] ?? l.trim())
const inCard = (lines: string[], label: string): number => lines.filter(l => l.includes(`(${label})`)).length
const ownRow = (lines: string[], label: string): number => lines.filter(l => new RegExp(`crewmate\\s+${label}\\b`).test(l)).length
const cardOf = (lines: string[]): string => lines.filter(l => /background crewmates launched|crewmate\s+\(seat-/.test(l)).join('\n')
const show = (title: string, lines: string[]): void => console.log(`  ${title}:\n${lines.map(l => `    ${l}`).join('\n')}`)
const SETTLE_MS = 600

section('§A four launches in one message, the fourth answered late: the card that said three says four')
{
  const s = sceneRecords(100, 'msg_late_1', Date.now() - 10_000)
  const calls = [s.prompt, s.words, s.launch.a, s.launch.b, s.launch.c, s.launch.d]
  const screen = await mount({ records: calls, running: new Set(Object.values(s.ids)) })
  await until(() => ownRow(screen.lines(), 'seat-d') > 0)
  screen.set([...calls, s.launched.a, s.launched.b, s.launched.c], [s.ids.d])
  const three = await until(() => cardHeads(screen.lines()).length === 1)
  await sleep(SETTLE_MS)
  const early = screen.lines()
  show('frame with three launches answered and the fourth still out', early)
  check('with three launches answered, the card counts the three that are launched', three && cardHeads(early).join('|') === '3 background crewmates launched' && ['seat-a', 'seat-b', 'seat-c'].every(label => inCard(early, label) === 1), j({ heads: cardHeads(early), lines: STATIONS.map(st => `${st}:${inCard(early, `seat-${st}`)}`) }))
  check('…and the fourth, still out, stands as a row of its own beside the card', ownRow(early, 'seat-d') === 1 && inCard(early, 'seat-d') === 0, j({ own: ownRow(early, 'seat-d'), card: inCard(early, 'seat-d') }))
  screen.set([...calls, s.launched.a, s.launched.b, s.launched.c, s.launched.d], [])
  await until(() => cardHeads(screen.lines()).join('|') === '4 background crewmates launched', 3000)
  await sleep(SETTLE_MS)
  const late = screen.lines()
  show('frame once the fourth launch is answered', late)
  check('THE DEFECT PIN: once the fourth launch is answered the card says four were launched, never three', cardHeads(late).join('|') === '4 background crewmates launched', j(cardHeads(late)))
  check('THE DEFECT PIN: every launch of the message has its line in the card, the late one among them, each once, and no row of its own beside it', STATIONS.every(st => inCard(late, `seat-${st}`) === 1) && ownRow(late, 'seat-d') === 0, j({ card: STATIONS.map(st => `${st}:${inCard(late, `seat-${st}`)}`), own: ownRow(late, 'seat-d') }))
  await screen.close()

  const before = [...calls, s.launched.a, s.launched.b, s.launched.c]
  const after = [...before, s.launched.d]
  const rowOf = (records: Rec[]): { message: unknown; lookups: unknown } => {
    const normalized = normalizeMessages(records as never)
    const grouped = applyGrouping(normalized.filter((m: { type: string }) => m.type !== 'progress') as never, tools as never).messages as Array<{ type: string; messages?: unknown[] }>
    return { message: grouped.find(m => m.type === 'grouped_tool_use'), lookups: buildMessageLookups(normalized as never, records as never) }
  }
  const prev = rowOf(before)
  const next = rowOf(after)
  const members = (row: { message: unknown }): number => ((row.message as { messages?: unknown[] } | undefined)?.messages ?? []).length
  check('the grouping itself is as it was: three members while the fourth is out, four once it is answered', members(prev) === 3 && members(next) === 4, j({ before: members(prev), after: members(next) }))
  const rest = { isUserContinuation: false, hasContentAfter: false, tools, verbose: false, streamingToolUseIDs: new Set<string>(), screen: 'prompt', canAnimate: true, lastThinkingBlockId: null, latestBashOutputUUID: null, columns: 140, isLoading: false }
  const equal = (areMessageRowPropsEqual as (a: unknown, b: unknown) => boolean)({ ...rest, ...prev, inProgressToolUseIDs: new Set([s.ids.d]) }, { ...rest, ...next, inProgressToolUseIDs: new Set<string>() })
  check('the row memo lets the card through when a member joins it', equal === false, String(equal))
}

section('§B a launch that was refused stays a row of its own: the card counts the three that were launched')
{
  const s = sceneRecords(200, 'msg_refused_1', Date.now() - 10_000)
  const calls = [s.prompt, s.words, s.launch.a, s.launch.b, s.launch.c, s.launch.d]
  const screen = await mount({ records: [...calls, s.launched.a, s.launched.b, s.launched.c], running: new Set([s.ids.d]) })
  await until(() => cardHeads(screen.lines()).length === 1)
  screen.set([...calls, s.launched.a, s.launched.b, s.launched.c, s.refused], [])
  await until(() => screen.frame().includes('refused'), 3000)
  await sleep(SETTLE_MS)
  const settled = screen.lines()
  show('frame with the fourth launch refused', settled)
  check('the card counts the three launches that were made', cardHeads(settled).join('|') === '3 background crewmates launched' && ['seat-a', 'seat-b', 'seat-c'].every(label => inCard(settled, label) === 1), j({ heads: cardHeads(settled), lines: STATIONS.map(st => `${st}:${inCard(settled, `seat-${st}`)}`) }))
  check('the refused launch stands once, outside the card, with its refusal', ownRow(settled, 'seat-d') === 1 && inCard(settled, 'seat-d') === 0 && screen.frame().includes('the launch of seat-d was refused'), j({ own: ownRow(settled, 'seat-d'), card: inCard(settled, 'seat-d') }))
  await screen.close()
}

section('§C a long call of another kind in the same message: the card waits for it as a plain row does, then settles')
{
  const s = sceneRecords(300, 'msg_beside_1', Date.now() - 10_000)
  const callsAs = (label: string): Rec[] => [s.prompt, s.words, s.launch.a, s.launch.b, s.launch.c, s.renamed(label), s.shell]
  const answers = [s.launched.a, s.launched.b, s.launched.c, s.launched.d]
  const screen = await mount({ records: [...callsAs('seat-d'), ...answers], running: new Set([s.shellId]) })
  await until(() => cardHeads(screen.lines()).length === 1)
  await sleep(SETTLE_MS)
  const beside = screen.lines()
  show('frame with the four launched and the long call still running', beside)
  check('while the other call runs the card stands once with its four launches, each once', cardHeads(beside).join('|') === '4 background crewmates launched' && STATIONS.every(st => inCard(beside, `seat-${st}`) === 1), j({ heads: cardHeads(beside), lines: STATIONS.map(st => `${st}:${inCard(beside, `seat-${st}`)}`) }))
  screen.set([...callsAs('seat-w'), ...answers], [s.shellId])
  const repainted = await until(() => inCard(screen.lines(), 'seat-w') === 1, 3000)
  await sleep(SETTLE_MS)
  check('while a call of its message is still out the card is not settled, as a plain row beside it is not: a change of one of its members is painted', repainted && inCard(screen.lines(), 'seat-d') === 0 && cardHeads(screen.lines()).join('|') === '4 background crewmates launched', j({ w: inCard(screen.lines(), 'seat-w'), d: inCard(screen.lines(), 'seat-d'), heads: cardHeads(screen.lines()) }))
  screen.set([...callsAs('seat-w'), ...answers, s.shellDone], [])
  await until(() => screen.frame().includes('Ran 1 bash command'), 3000)
  await sleep(SETTLE_MS)
  const done = screen.lines()
  show('frame once the long call is answered', done)
  check('once the other call is answered the card stands once with its four launches, nothing painted twice', cardHeads(done).join('|') === '4 background crewmates launched' && done.filter(l => /crewmate\s+\(seat-/.test(l)).length === 4, j({ heads: cardHeads(done), members: done.filter(l => /crewmate\s+\(seat-/.test(l)).length }))
  screen.set([...callsAs('seat-x'), ...answers, s.shellDone], [])
  await sleep(SETTLE_MS * 2)
  const first = cardOf(screen.lines())
  screen.set([...callsAs('seat-y'), ...answers, s.shellDone], [])
  await sleep(SETTLE_MS * 2)
  const second = cardOf(screen.lines())
  console.log(`  the card's last member after the first later change: ${first.split('\n').at(-1)?.trim() ?? ''} · after the second: ${second.split('\n').at(-1)?.trim() ?? ''}`)
  check('…and then it is settled: with every call of the message answered, the card painted once more at most and a later change of the record repaints nothing', second === first && inCard(screen.lines(), 'seat-y') === 0, j({ first, second }))
  await screen.close()
}

clearTimeout(hardLimit)
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-launch-card-late-member: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
