#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'crew-row-parked-ask-')))
const daemonDir = join(SCRATCH, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    void 0
  }
})

console.log('============================================================')
console.log(" a crewmate's parked permission ask names itself on the crew row: what it asks to run, and the clock that refuses it by itself")
console.log('============================================================')

const words = await import(join(ROOT, 'src/utils/permissions/askWords.ts')).catch(() => null)
const crewFacts = await import(join(ROOT, 'src/services/engine-connector/crewFacts.ts'))
const { pauseClockWords } = await import(join(ROOT, 'src/tasks/LocalAgentTask/agentPause.ts'))

const NOW = Date.UTC(2026, 9, 9, 6, 30, 0)
const ASKED_AT = NOW - 60_000
const LIMIT = 10 * 60_000

section('§1 the words — one writer for the board row and the crew row')
{
  check('the ask words module exists', words !== null)
  if (words !== null) {
    check('the crew row names the tool the way the board row does', words.askToRunWords('Read') === 'asks to run Read — allow?')
    check('the board row is the subject plus the same words', words.askBoardQuestion('seat one', 'Read') === '"seat one" asks to run Read — allow?')
    const clock = words.askClockWords(ASKED_AT, LIMIT, NOW)
    check(
      "the clock rides the row's own grammar (refused by itself at HH:MM (in Xm))",
      clock === `refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
      String(clock),
    )
    check('an ask with no clock names none', words.askClockWords(ASKED_AT, undefined, NOW) === null && words.askClockWords(ASKED_AT, 0, NOW) === null)
    check('a clock that ran out says so', words.askClockWords(ASKED_AT, 30_000, NOW) === 'refused by itself now')
    check(
      'the row sentence is the words, then the clock',
      words.parkedAskRowWords({ toolName: 'Bash', askedAt: ASKED_AT, limitMs: LIMIT }, NOW) === `asks to run Bash — allow? · refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
    )
    check('…and the words alone without a clock', words.parkedAskRowWords({ toolName: 'Bash', askedAt: ASKED_AT }, NOW) === 'asks to run Bash — allow?')
  }
}

section("§2 the daemon's parked card carries the crewmate and its clock")
{
  const asks = await import(join(ROOT, 'src/daemon/permissionAsks.ts'))
  const { concourseWorkersPath } = await import(join(ROOT, 'src/daemon/concourseWorkers.ts'))
  const { readSessionAsks } = await import(join(ROOT, 'src/services/engine-connector/seatProjections.ts'))
  const record = (short: string): Record<string, unknown> => ({
    runnerId: short,
    sessionId: `sess-${short}`,
    workspaceId: join(SCRATCH, 'ws'),
    title: `t-${short}`,
    createdAt: Date.now(),
    startedAt: Date.now(),
    permissionMode: 'default',
  })
  writeFileSync(concourseWorkersPath(daemonDir), JSON.stringify({ version: 1, workers: { 'concourse-w1': record('concourse-w1') } }))
  const crewmate = asks.holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: 'tu-crew', tool_name: 'Read', input: { file_path: '/outside/notes.md' }, agent_id: 'agent-fjord' }, daemonDir, undefined, () => 'attached')
  const own = asks.holdWorkerAsk('concourse-w1', { kind: 'tool', tool_use_id: 'tu-main', tool_name: 'Bash', input: { command: 'git push' } }, daemonDir, undefined, () => 'attached')
  const projection = readSessionAsks('sess-concourse-w1', daemonDir)
  const rows = projection?.asks ?? []
  const crewRow = rows.find(r => r.toolUseId === 'tu-crew') as (Record<string, unknown> | undefined)
  const mainRow = rows.find(r => r.toolUseId === 'tu-main') as (Record<string, unknown> | undefined)
  check('both asks are published for the session', rows.length === 2, JSON.stringify(rows.map(r => r.toolUseId)))
  check("the crewmate's card names its agent", crewRow?.agentId === 'agent-fjord', JSON.stringify(crewRow))
  check("…and carries the crewmate's clock (Default: 10 min)", crewRow?.limitMs === LIMIT, JSON.stringify(crewRow?.limitMs))
  check('…and when it was asked', typeof crewRow?.askedAt === 'number')
  check("the session's own ask names no agent and no clock (its runner clocks it)", mainRow !== undefined && mainRow.agentId === undefined && mainRow.limitMs === undefined, JSON.stringify(mainRow))
  const retired = asks.retireWorkerAsks('concourse-w1', 'the proof is over', daemonDir)
  check('the proof retires both asks', retired.length === 2, JSON.stringify(retired))
  void crewmate
  void own
}

section("§3 the facts: the row's own asks, joined by the crewmate's id")
{
  const facts = { id: 'agent-fjord', running: true, pendingAsks: 1 }
  const parked = [{ id: 'req-1', toolName: 'Read', agentId: 'agent-fjord', askedAt: ASKED_AT, limitMs: LIMIT }, { id: 'req-2', toolName: 'Bash', agentId: 'agent-other', askedAt: ASKED_AT }]
  const fn = (crewFacts as Record<string, unknown>).crewAskWaitDetail as ((f: unknown, a: unknown, n: number) => string | null) | undefined
  check('crewFacts owns the reader', typeof fn === 'function')
  if (fn !== undefined) {
    check(
      "a running row with a parked ask reads the ask's words and clock",
      fn(facts, parked, NOW) === `asks to run Read — allow? · refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
      String(fn(facts, parked, NOW)),
    )
    check("another crewmate's ask never lands on this row", fn({ id: 'agent-nobody', running: true, pendingAsks: 1 }, parked, NOW) === null)
    check('a count with no card to read stays silent (the count stands)', fn(facts, [], NOW) === null)
    check('a settled row reads nothing', fn({ id: 'agent-fjord', running: false, pendingAsks: 1 }, parked, NOW) === null)
    check('a row with no pending ask reads nothing even when a stale card lingers', fn({ id: 'agent-fjord', running: true, pendingAsks: 0 }, parked, NOW) === null)
  }
}

section('§4 the crew view paints the sentence on the row')
{
  const React = (await import('react')).default
  const { render } = await import(join(ROOT, 'src/ink.ts'))
  const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
  const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
  const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
  enableConfigs()
  const { noSessionConnector } = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
  const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
  const { CrewView } = await import(join(ROOT, 'src/components/mercury-ui/screens/CrewView.tsx'))
  const h = React.createElement as (...a: unknown[]) => React.ReactElement
  const SESSION_ID = 'sess-crew-row'
  const now = Date.now()
  const roster = {
    rows: [
      { id: 'agent-fjord', agentId: 'agent-fjord', kind: 'agent', name: 'fjord', status: 'running', startTime: now - 45_000, model: 'claude-opus-5-5', pendingAsks: 1, contextTokens: 890, inputTokens: 800, outputTokens: 90 },
    ],
    mission: { items: [] },
    samples: [],
  }
  const asks = [
    { id: 'req-crew', confirm: {} as never, toolName: 'Read', agentId: 'agent-fjord', askedAt: now - 60_000, limitMs: LIMIT },
  ]
  const base = noSessionConnector() as unknown as Record<string, unknown>
  const overrides: Record<string, unknown> = {
    sessionId: () => SESSION_ID,
    workRoster: () => roster,
    subscribeWork: () => () => {},
    asks: () => asks,
    subscribeAsks: () => () => {},
  }
  setFocusedSessionConnector(new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as never)
  const paint = async (columns: number): Promise<string> => {
    let written = ''
    const stdout = Object.assign(
      new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
      { columns, rows: 40, isTTY: false },
    ) as unknown as NodeJS.WriteStream
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
    const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(CrewView as never, { onClose: () => {} })), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
    await settle(700)
    const frame = strip(instance.lastFrame())
    instance.unmount?.()
    await settle(30)
    return frame.split('\n').find(l => l.includes('fjord')) ?? frame
  }
  const wide = await paint(220)
  const narrow = await paint(160)
  _resetFocusedSessionConnectorForTesting()
  check('the row stands with the status cell the count already gave it', wide.includes('waiting for your answer'), wide)
  check('RED ON THE BASE: the row says what the crewmate asks to run', wide.includes('asks to run Read — allow?'), wide)
  check("…and the clock in the row's own grammar", /refused by itself at \d\d:\d\d \(in \d+m\)/.test(wide), wide)
  check('the ask sits on the tail after the elapsed time', wide.indexOf('asks to run Read') > wide.indexOf('waiting for your answer'), wide)
  check('at 160 columns the words still stand and the tail sheds the clock last', narrow.includes('asks to run Read — allow?'), narrow)
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-crew-row-parked-ask: ${failures} failure(s)`)
  process.exit(1)
}
console.log("✅ prove-crew-row-parked-ask: the crew row names the crewmate's parked ask and its clock")
process.exit(0)
