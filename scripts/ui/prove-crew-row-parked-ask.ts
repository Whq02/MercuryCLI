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

const words = await import(join(ROOT, 'src/permissions/rules/askWords.ts')).catch(() => null)
const crewFacts = await import(join(ROOT, 'src/engine/connector/crewFacts.ts'))
const { pauseClockWords } = await import(join(ROOT, 'src/engine/tasks/local-agent/agentPause.ts'))

const NOW = Date.UTC(2026, 9, 9, 6, 30, 0)
const ASKED_AT = NOW - 60_000
const LIMIT = 10 * 60_000

section('§1 the words — one writer for the board row and the crew row')
{
  check('the ask words module exists', words !== null, 'src/permissions/rules/askWords.ts did not import: restore it with askToRunWords, askBoardQuestion, askClockWords and parkedAskRowWords')
  if (words !== null) {
    check('the crew row names the tool the way the board row does', words.askToRunWords('Read') === 'asks to run Read — allow?', 'fix askToRunWords in src/permissions/rules/askWords.ts')
    check('the board row is the subject plus the same words', words.askBoardQuestion('seat one', 'Read') === '"seat one" asks to run Read — allow?', 'fix askBoardQuestion in src/permissions/rules/askWords.ts')
    const clock = words.askClockWords(ASKED_AT, LIMIT, NOW)
    check(
      "the clock rides the row's own grammar (refused by itself at HH:MM (in Xm))",
      clock === `refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
      String(clock),
    )
    check('an ask with no clock names none', words.askClockWords(ASKED_AT, undefined, NOW) === null && words.askClockWords(ASKED_AT, 0, NOW) === null, 'fix askClockWords in src/permissions/rules/askWords.ts so no limit means no clock')
    check('a clock that ran out says so', words.askClockWords(ASKED_AT, 30_000, NOW) === 'refused by itself now', 'fix askClockWords in src/permissions/rules/askWords.ts for a limit already past')
    check(
      'the row sentence is the words, then the clock',
      words.parkedAskRowWords({ toolName: 'Bash', askedAt: ASKED_AT, limitMs: LIMIT }, NOW) === `asks to run Bash — allow? · refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
      'fix parkedAskRowWords in src/permissions/rules/askWords.ts: the words, then the clock after a middle dot',
    )
    check('…and the words alone without a clock', words.parkedAskRowWords({ toolName: 'Bash', askedAt: ASKED_AT }, NOW) === 'asks to run Bash — allow?', 'fix parkedAskRowWords in src/permissions/rules/askWords.ts so an ask with no limit prints no clock')
  }
}

section("§2 the daemon's parked card carries the crewmate and its clock")
{
  const asks = await import(join(ROOT, 'src/daemon/session-seat/permissionAsks.ts'))
  const { concourseWorkersPath } = await import(join(ROOT, 'src/daemon/concourse-workers/concourseWorkers.ts'))
  const { readSessionAsks } = await import(join(ROOT, 'src/engine/connector/seatProjections.ts'))
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
  check('both asks are published for the session', rows.length === 2, `${JSON.stringify(rows.map(r => r.toolUseId))} · holdWorkerAsk in src/daemon/session-seat/permissionAsks.ts must publish each ask where readSessionAsks in src/engine/connector/seatProjections.ts reads it`)
  check("the crewmate's card names its agent", crewRow?.agentId === 'agent-fjord', `${JSON.stringify(crewRow)} · carry the ask's agent_id into the published card in src/daemon/session-seat/permissionAsks.ts`)
  check("…and carries the crewmate's clock (Default: 10 min)", crewRow?.limitMs === LIMIT, `${JSON.stringify(crewRow?.limitMs)} · a crewmate ask must carry a ten minute limitMs in src/daemon/session-seat/permissionAsks.ts`)
  check('…and when it was asked', typeof crewRow?.askedAt === 'number', 'a published ask must carry askedAt: see src/daemon/session-seat/permissionAsks.ts')
  check("the session's own ask names no agent and no clock (its runner clocks it)", mainRow !== undefined && mainRow.agentId === undefined && mainRow.limitMs === undefined, `${JSON.stringify(mainRow)} · only an ask with an agent_id gets agentId and limitMs in src/daemon/session-seat/permissionAsks.ts`)
  const retired = asks.retireWorkerAsks('concourse-w1', 'the proof is over', daemonDir)
  check('the proof retires both asks', retired.length === 2, `${JSON.stringify(retired)} · retireWorkerAsks in src/daemon/session-seat/permissionAsks.ts must retire every ask held for the worker`)
  void crewmate
  void own
}

section("§3 the facts: the row's own asks, joined by the crewmate's id")
{
  const facts = { id: 'agent-fjord', running: true, pendingAsks: 1 }
  const parked = [{ id: 'req-1', toolName: 'Read', agentId: 'agent-fjord', askedAt: ASKED_AT, limitMs: LIMIT }, { id: 'req-2', toolName: 'Bash', agentId: 'agent-other', askedAt: ASKED_AT }]
  const fn = (crewFacts as Record<string, unknown>).crewAskWaitDetail as ((f: unknown, a: unknown, n: number) => string | null) | undefined
  check('crewFacts owns the reader', typeof fn === 'function', 'export crewAskWaitDetail from src/engine/connector/crewFacts.ts')
  if (fn !== undefined) {
    check(
      "a running row with a parked ask reads the ask's words and clock",
      fn(facts, parked, NOW) === `asks to run Read — allow? · refused by itself at ${pauseClockWords(ASKED_AT + LIMIT)} (in 9m)`,
      `${String(fn(facts, parked, NOW))} · fix crewAskWaitDetail in src/engine/connector/crewFacts.ts`,
    )
    check("another crewmate's ask never lands on this row", fn({ id: 'agent-nobody', running: true, pendingAsks: 1 }, parked, NOW) === null, 'crewAskWaitDetail in src/engine/connector/crewFacts.ts must match asks by the row agent id')
    check('a count with no card to read stays silent (the count stands)', fn(facts, [], NOW) === null, 'crewAskWaitDetail in src/engine/connector/crewFacts.ts must return null when no card matches')
    check('a settled row reads nothing', fn({ id: 'agent-fjord', running: false, pendingAsks: 1 }, parked, NOW) === null, 'crewAskWaitDetail in src/engine/connector/crewFacts.ts must return null for a row that is not running')
    check('a row with no pending ask reads nothing even when a stale card lingers', fn({ id: 'agent-fjord', running: true, pendingAsks: 0 }, parked, NOW) === null, 'crewAskWaitDetail in src/engine/connector/crewFacts.ts must return null when pendingAsks is 0')
  }
}

section('§4 the crew view paints the sentence on the row')
{
  const React = (await import('react')).default
  const { render } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
  const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
  const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
  const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
  enableConfigs()
  const { noSessionConnector } = await import(join(ROOT, 'src/engine/connector/noSessionConnector.ts'))
  const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/engine/connector/focusedConnector.ts'))
  const { CrewView } = await import(join(ROOT, 'src/screen/widgets/faces/CrewView.tsx'))
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
  check('the row stands with the status cell the count already gave it', wide.includes('waiting for your answer'), `${wide} · the row status cell for pendingAsks is painted by src/screen/widgets/faces/CrewView.tsx`)
  check('RED ON THE BASE: the row says what the crewmate asks to run', wide.includes('asks to run Read — allow?'), `${wide} · CrewView in src/screen/widgets/faces/CrewView.tsx must paint the crewAskWaitDetail sentence on the row`)
  check("…and the clock in the row's own grammar", /refused by itself at \d\d:\d\d \(in \d+m\)/.test(wide), `${wide} · the row must carry the clock words from askClockWords in src/permissions/rules/askWords.ts`)
  check('the ask sits on the tail after the elapsed time', wide.indexOf('asks to run Read') > wide.indexOf('waiting for your answer'), `${wide} · the ask sentence goes after the status cell on the row in src/screen/widgets/faces/CrewView.tsx`)
  check('at 160 columns the words still stand and the tail sheds the clock last', narrow.includes('asks to run Read — allow?'), `${narrow} · at 160 columns the row in src/screen/widgets/faces/CrewView.tsx must shed the clock before the ask words`)
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-crew-row-parked-ask: ${failures} failure(s)`)
  process.exit(1)
}
console.log("✅ prove-crew-row-parked-ask: the crew row names the crewmate's parked ask and its clock")
process.exit(0)
