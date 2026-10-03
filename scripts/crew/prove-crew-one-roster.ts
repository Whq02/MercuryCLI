#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'
import type { WireRosterEntry } from '../../src/daemon/protocol.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const frameDir = argument('--frames')
const scratch = mkdtempSync(join(tmpdir(), 'crew-one-roster-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
process.env.MERCURY_CREWS_DIR = join(scratch, 'crews')
mkdirSync(process.env.MERCURY_CREWS_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) process.env[k] = '0'
delete process.env.MERCURY_CREW
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const SEAT = 'harbour'
const SEAT_MODEL = 'claude-sonnet-5'
const MATE = 'atlas'
const MATE_MODEL = 'claude-opus-4-6'
const MATE_CWD = join(scratch, 'repo')
const MATE_WORKTREE = join(MATE_CWD, '.mercury', 'worktrees', 'agent-a1atlas00')
const SEAT_CWD = join(scratch, 'seat-repo')
const SEAT_WORKTREE = join(SEAT_CWD, '.mercury', 'worktrees', 'agent-a1harbour')
const t0 = Date.now() - 95_000

async function main(): Promise<void> {
  const src = (relative: string): string => join(ROOT, 'src', relative)
  const { enableConfigs } = await import(src('utils/config.ts'))
  enableConfigs()
  const { projectWorkRoster } = await import(src('utils/task/workRoster.ts'))
  const crew = await import(src('services/engine-connector/crewFacts.ts'))
  const { createTaskStateBase } = await import(src('Task.ts'))
  type TaskState = import('../../src/tasks/types.ts').TaskState

  section('R1 the record: a session crewmate row carries the four start inputs; the roster module joins seats and crewmates into ONE list')
  const mateTask = {
    ...createTaskStateBase('t1atlas000', 'in_process_crewmate', `${MATE}: the mate`),
    type: 'in_process_crewmate',
    status: 'running',
    identity: { agentId: `${MATE}@crew`, agentName: MATE, crewName: 'crew', parentSessionId: 'lead' },
    prompt: 'the mate',
    model: MATE_MODEL,
    cwd: MATE_CWD,
    worktree: MATE_WORKTREE,
    transcriptAgentId: 'a1atlas000',
    isIdle: false,
    shutdownRequested: false,
    messages: [],
  } as unknown as TaskState
  const mateRow = projectWorkRoster({ t1atlas000: mateTask })[0] as (WorkRowV1 & { worktree?: string }) | undefined
  check('the roster row of a crewmate carries the folder it was started in', mateRow?.cwd === MATE_CWD, JSON.stringify(mateRow))
  check('…and the worktree it runs in', mateRow?.worktree === MATE_WORKTREE, JSON.stringify(mateRow))
  const mateFacts = mateRow === undefined ? null : (crew.crewAgentFactsOf(mateRow, 'lead') as ({ cwd?: string | null; worktree?: string | null; model: string | null; name: string } | null))
  check('the crew facts carry cwd and worktree (the one record every surface paints)', mateFacts?.cwd === MATE_CWD && mateFacts?.worktree === MATE_WORKTREE, JSON.stringify(mateFacts))
  type Roster = typeof import('../../src/services/crew/roster.ts')
  let roster: Roster | null = null
  try {
    roster = await import(src('services/crew/roster.ts'))
  } catch (error) {
    check('the roster module exists (src/services/crew/roster.ts)', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  }
  const seatGlance = { name: SEAT, model: SEAT_MODEL, online: true, unread: 2, busy: true, pid: 4242, startedAt: t0 + 2_000, joinedAt: t0, cwd: SEAT_CWD, worktree: SEAT_WORKTREE }
  if (roster !== null && mateFacts !== null) {
    const records = roster.crewRosterOf([mateFacts as never], [seatGlance])
    const mate = records.find(r => r.name === MATE)
    const seat = records.find(r => r.name === SEAT)
    check('one list holds the session crewmate and the daemon seat', records.length === 2 && mate !== undefined && seat !== undefined, JSON.stringify(records.map(r => `${r.kind}:${r.name}`)))
    check("the crewmate's record: kind crewmate, the session runner, its task id, the four start inputs", mate?.kind === 'crewmate' && mate.runner.kind === 'session' && mate.runner.taskId === 't1atlas000' && mate.cwd === MATE_CWD && mate.worktree === MATE_WORKTREE && mate.model === MATE_MODEL, JSON.stringify(mate))
    check("the seat's record: kind seat, the daemon runner with its pid, its folder, worktree and model", seat?.kind === 'seat' && seat.runner.kind === 'daemon' && seat.runner.pid === 4242 && seat.cwd === SEAT_CWD && seat.worktree === SEAT_WORKTREE && seat.model === SEAT_MODEL, JSON.stringify(seat))
    check('a busy seat reads running, in the one state vocabulary', seat?.state === 'running' && seat.facts.running === true, JSON.stringify(seat?.facts))
    const idle = roster.crewRosterOf([], [{ ...seatGlance, busy: false }])[0]
    const offline = roster.crewRosterOf([], [{ ...seatGlance, online: false, busy: undefined, pid: undefined, startedAt: undefined }])[0]
    check('an online idle seat reads idle; an offline seat reads stopped and is not running', idle?.state === 'idle' && idle.facts.running === true && offline?.state === 'stopped' && offline.facts.running === false, `${idle?.state} · ${offline?.state}`)
    check("the busy read lane 25 takes is the record's state", roster.crewRosterBusy(records).map(r => r.name).sort().join(',') === [MATE, SEAT].sort().join(','), JSON.stringify(roster.crewRosterBusy(records).map(r => r.name)))
  }

  section('R2 the daemon: a seat registered through the start road lists its folder and worktree on the wire')
  {
    const { TaskRoster } = await import(src('daemon/roster.ts'))
    const { DaemonBreaker } = await import(src('utils/daemonBreaker.ts'))
    const taskRoster = new TaskRoster({ dir: scratch, breaker: new DaemonBreaker(), maxInflight: 1 })
    check('the daemon roster lists no seat before one is registered', taskRoster.list().length === 0)
    const source = (await import('node:fs')).readFileSync(join(ROOT, 'src/daemon/roster.ts'), 'utf8')
    check('the roster entry carries the seat\'s start folder and worktree (RosterEntry.cwd / worktree)', /cwd\?: string\n\s+worktree\?: string/.test(source), 'RosterEntry has no cwd/worktree')
    check('registerLongLived takes the start beside the spec', /registerLongLived\(\n\s+short: string,\n\s+spec: RunnerChildSpec,\n\s+opts\?: Partial<LongLivedSupervisorConfig>,\n\s+start\?: \{ cwd: string; worktree\?: string \}/.test(source), 'registerLongLived has no start parameter')
    const handler = (await import('node:fs')).readFileSync(join(ROOT, 'src/daemon/crewSpawn.ts'), 'utf8')
    check('the seat door hands the plan\'s folder and worktree to the roster', handler.includes("{ cwd: folder, ...(plan.worktree !== null ? { worktree: plan.worktree.path } : {}) }"), 'crewSpawn.ts registers the seat without its start')
  }

  section('R3 the view: with a daemon seat up and a session crewmate up, the crew view lists both in ONE list')
  const { startControlServer } = await import(src('daemon/controlServer.ts'))
  const { mintControlKey } = await import(src('daemon/controlSocket.ts'))
  const { DaemonBreaker } = await import(src('utils/daemonBreaker.ts'))
  const th = await import(src('utils/swarm/crewHelpers.ts'))
  const member = (name: string, agentId: string, role: string, extra: Record<string, unknown> = {}) => ({ agentId, name, role, joinedAt: t0, tmuxPaneId: '', cwd: scratch, subscriptions: [] as string[], ...extra })
  await th.writeCrewFileAsync('crew', {
    name: 'crew',
    description: 'the crew',
    createdAt: t0,
    leadAgentId: 'crew-lead@crew',
    governance: { broadcastEnabled: false },
    members: [member('crew-lead', 'crew-lead@crew', 'lead'), member(SEAT, `${SEAT}@crew`, 'crewmate', { model: SEAT_MODEL, cwd: SEAT_CWD, worktreePath: SEAT_WORKTREE })],
  } as never)
  const seatEntry: WireRosterEntry & { cwd?: string; worktree?: string } = {
    short: SEAT,
    sessionId: 'seat-session',
    prompt: '[long-lived MERCURY_CREW]',
    source: 'dispatch',
    state: 'running',
    pid: 4242,
    startedAt: t0 + 2_000,
    cliVersion: '1.0.0',
    via: 'runner',
    model: SEAT_MODEL,
    effort: 'high',
    busy: true,
    turnActive: true,
    turnStartedAt: t0 + 60_000,
    cwd: SEAT_CWD,
    worktree: SEAT_WORKTREE,
  }
  const fakeRoster = { list: () => [seatEntry], has: (short: string) => ({ alive: short === SEAT, present: short === SEAT, ready: short === SEAT }) }
  const key = await mintControlKey()
  const server = await startControlServer({
    roster: fakeRoster as never,
    breaker: new DaemonBreaker(),
    dir: scratch,
    startedAt: Date.now(),
    maxInflight: 1,
    controlKey: key,
    isReady: () => true,
    onShutdown: () => 0,
  } as never)

  const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
  const slot = await import(src('services/engine-connector/focusedConnector.ts'))
  const { CrewView } = await import(src('components/mercury-ui/screens/CrewView.tsx'))
  const ink = await import(src('ink.ts'))
  const { default: StdinContext } = await import(src('ink/components/StdinContext.ts'))
  const { AppStoreContext } = await import(src('state/AppState.tsx'))
  const { createStore } = await import(src('state/store.ts'))
  const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
  const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default
  const rows: WorkRowV1[] = [
    { ...(mateRow as WorkRowV1), startTime: t0 + 1_000 },
    { id: 'ag-scout', agentId: 'ag-scout', kind: 'agent', name: 'scout the release notes', status: 'running', startTime: t0 + 4_000, agentType: 'mercury-crew', model: 'claude-fable-5-1', inputTokens: 9_800, outputTokens: 2_500, contextTokens: 12_300, toolUses: 3, activity: 'reading the notes' },
  ]
  const listeners = new Set<() => void>()
  const work = { rows, mission: [] as never[], samples: [] as never[], reported: true }
  const seat = Object.assign(Object.create(noSessionConnector()), {
    carrier: 'in-process',
    sessionId: () => 'fx-session',
    records: () => [],
    subscribeRecords: () => () => {},
    workRoster: () => work,
    subscribeWork: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    identity: () => ({ firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: null }),
    spawnSwitches: () => ({ subagents: { on: true, source: 'default' }, workflows: { on: true, source: 'default' } }),
  })
  slot.setFocusedSessionConnector(seat as never)
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolveTick => setTimeout(resolveTick, 5))
    }
  }
  async function mount(columns: number, rowsN: number) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: rowsN }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const store = createStore(getDefaultAppState())
    const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(CrewView, { onClose: () => {} })))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolvePaint => { painted = resolvePaint })
    const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      close(): void {
        instance.unmount()
        instance.cleanup()
        stream.destroy()
      },
    }
  }
  if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
  const saveFrame = (name: string, frame: string): void => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), `${frame}\n`)
  }
  try {
    for (const [columns, rowsN] of [[178, 51], [80, 21]] as const) {
      const board = await mount(columns, rowsN)
      const until = Date.now() + 20_000
      while (!board.frame().includes(SEAT) && Date.now() < until) await settle()
      const frame = board.frame()
      saveFrame(`crew-one-roster-${columns}x${rowsN}`, frame)
      const lines = frame.split('\n')
      const seatLine = lines.findIndex(line => line.includes(`@${SEAT}`))
      const mateLine = lines.findIndex(line => line.includes(MATE) && !line.includes('@'))
      const scoutLine = lines.findIndex(line => line.includes('scout the release'))
      const apartHeader = lines.findIndex(line => /Named agents/.test(line))
      check(`${columns}x${rowsN}: the daemon seat @${SEAT} is on the view`, seatLine >= 0, frame)
      check(`${columns}x${rowsN}: the session crewmates are on the view`, mateLine >= 0 && scoutLine >= 0, frame)
      check(`${columns}x${rowsN}: the seat is in the SAME list — no second header stands between the crewmates and the seat`, apartHeader < 0, `a "Named agents" header at line ${apartHeader}: ${lines[apartHeader] ?? ''}`)
      check(`${columns}x${rowsN}: the seat's row paints the same columns — its model and its status word beside the name`, seatLine >= 0 && lines[seatLine]!.includes(SEAT_MODEL.slice(0, 12)) && /running|busy|online/.test(lines[seatLine]!), lines[seatLine] ?? '')
      check(`${columns}x${rowsN}: the one list is ordered by the ledger's law — running rows first, newest first (the seat at ${t0 + 2_000} sits between the two crewmates)`, scoutLine >= 0 && seatLine > scoutLine && mateLine > seatLine, `scout ${scoutLine} · seat ${seatLine} · mate ${mateLine}`)
      const header = lines.find(line => /Sub-agents|Crew|crewmates/i.test(line) && /\d/.test(line)) ?? ''
      check(`${columns}x${rowsN}: the one header counts every crewmate, the seat included`, /3/.test(header), header)
      board.close()
    }
  } finally {
    slot._resetFocusedSessionConnectorForTesting()
    await server.close()
  }
}

try {
  await main()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('─'.repeat(76))
console.log(failures === 0 ? `ALL PASS — ${checks} checks` : `FAILURES: ${failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
