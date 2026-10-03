#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const home = mkdtempSync(join(tmpdir(), 'seat-protocol-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(home, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREWS_DIR = join(home, 'crews')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const tick = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const { PassThrough } = await import('node:stream')
const { EventEmitter } = await import('node:events')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { RPC_REFUSED } = await import('../../src/runner/wire/errors.ts')
const { mock } = await import('bun:test')

type StandInChild = EventEmitter & { pid: number; stdin: InstanceType<typeof PassThrough>; stdout: InstanceType<typeof PassThrough>; stderr: InstanceType<typeof PassThrough>; kill: (signal?: NodeJS.Signals) => boolean; killed: NodeJS.Signals[]; alive: boolean; end: () => void }
const children: StandInChild[] = []
function standInChild(pid: number): StandInChild {
  const child = Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: [] as NodeJS.Signals[], alive: true }) as StandInChild
  child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    child.killed.push(signal)
    return true
  }
  child.end = () => {
    if (!child.alive) return
    child.alive = false
    child.emit('exit', null, child.killed[0] ?? null)
    child.emit('close', null, child.killed[0] ?? null)
  }
  children.push(child)
  return child
}
const childModule = await import('../../src/daemon/headlessRun.ts')
mock.module('../../src/daemon/headlessRun.ts', () => ({ ...childModule, spawnRunnerChild: () => ({ child: standInChild(40_000 + children.length), capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }) }))
const processGroup = await import('../../src/utils/processGroup.ts')
mock.module('../../src/utils/processGroup.ts', () => ({ ...processGroup, killProcessGroup: (child: StandInChild, signal: NodeJS.Signals) => child.kill(signal) }))
const { TaskRoster } = await import('../../src/daemon/roster.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))
const sup = await import('../../src/daemon/concourseSupervisor.ts')

const stamp = (sessionId: string) => ({ timestamp: '2026-10-03T16:00:00.000Z', session_id: sessionId })
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }

type Rig = { short: string; sessionId: string; roster: InstanceType<typeof TaskRoster>; child: StandInChild; runner: ReturnType<typeof createPeer>; seq: () => number }
async function openSeat(short: string, sessionId: string, answerInitialize: () => unknown): Promise<Rig> {
  const roster = new TaskRoster({ dir: home, breaker: { shouldSuppressFire: () => false, recordResult: () => {}, recordTimeout: () => {} } as never, maxInflight: 3 })
  sup.updateConcourseWorkers(ws => {
    ws[short] = { schema: 1, runnerId: short, sessionId, workspaceId: home, isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: Date.now() }
  }, daemonDir)
  const before = children.length
  roster.registerLongLived(short, { cwd: home, model: 'm', effort: 'high', role: 'MERCURY_CONCOURSE_WORKER', agentId: short } as never)
  const child = children[before]!
  let seq = 0
  const runner = createPeer({ input: child.stdin, output: child.stdout, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () => answerInitialize() as never)
  runner.onRequest('schedule/roster', () => ({}))
  runner.onRequest('queue/add', () => {
    runner.notify('row', { type: 'turn', seq: ++seq, ...stamp(sessionId), turn: 1, state: 'started', turn_id: `t-${short}`, message_ids: [`m-${short}`] } as never)
    return { accepted: true }
  })
  runner.onRequest('session/facts', () => ({ facts: 'stand-in' }))
  return { short, sessionId, roster, child, runner, seq: () => ++seq }
}

const seatRow = (rig: Rig) => rig.roster.list().find(e => e.short === rig.short)

section("§1 a seat whose runner answers a schema the daemon does not read: the open turn settles, the record with it, the child is ended")
{
  const rig = await openSeat('concourse-w7', 'session-7', () => ({ protocol: 1, runner: { version: '0', pid: 40_001 }, session_id: 'session-7' }))
  const delivered = await rig.roster.reply(rig.short, { type: 'prompt', content: 'work', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a01' })
  await tick()
  const open = seatRow(rig)
  check('the delivery is accepted and the turn opens (busy)', delivered && open?.busy === true && open.turnActive === true, j({ delivered, busy: open?.busy, turnActive: open?.turnActive }))
  rig.runner.notify('row', { type: 'outcome', seq: rig.seq(), ...stamp(rig.sessionId), schema: 2, turn: 1, turn_id: 't-concourse-w7', status: 'completed', steps: 0, wall_ms: 1, usage, models: {}, denials: [] } as never)
  await tick()
  await tick()
  const after = seatRow(rig)
  check('red on the base: the seat is freed — the open turn settles the moment the runner’s wire is refused', after?.busy === false && after.turnActive === false, j({ busy: after?.busy, turnActive: after?.turnActive, state: after?.state }))
  const record = sup.readSessionWorkers(daemonDir)[rig.short]
  check("red on the base: the record's turn is settled too (the board never paints 'working' against a refused runner)", record !== undefined && !sup.turnInFlightOf(record), j({ delivery: record?.lastDeliveryAt, settled: record?.lastTurnSettledAt }))
  check('red on the base: the child is ended (SIGTERM to its tree), never left alive behind a closed door', rig.child.killed.length > 0, j({ killed: rig.child.killed }))
  check('the seat’s door is closed to later verbs (no live child stands behind it)', rig.roster.door(rig.short) === undefined)
  const before = children.length
  rig.child.end()
  await tick(30)
  check('the exit path takes over: the ended runner is relaunched like a crash, the refusal kept as the reason', children.length === before + 1 && (seatRow(rig)?.state === 'spawning' || seatRow(rig)?.state === 'running'), j({ children: children.length, state: seatRow(rig)?.state }))
  rig.roster.kill(rig.short)
  rig.runner.close('done')
}

section("§2 a runner that answers initialize with another protocol never opens a turn: the seat refuses the delivery and the child is ended")
{
  const rig = await openSeat('concourse-w8', 'session-8', () => ({ protocol: 2, runner: { version: '0', pid: 40_002 }, session_id: 'session-8' }))
  await tick()
  await tick()
  const delivered = await rig.roster.reply(rig.short, { type: 'prompt', content: 'work', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a02' })
  const row = seatRow(rig)
  check('the delivery is refused (the door closed on the protocol refusal) and the seat is not busy', delivered === false && row?.busy !== true && row?.turnActive !== true, j({ delivered, busy: row?.busy, turnActive: row?.turnActive }))
  check('red on the base: the child is ended', rig.child.killed.length > 0, j({ killed: rig.child.killed }))
  rig.roster.kill(rig.short)
  rig.runner.close('done')
}

section('§3 the refusal is the peer’s typed -32010, kind protocol — the daemon reads it from the connection, not from an English line')
{
  const { RunnerConnection } = await import('../../src/daemon/runnerConnection.ts')
  const toRunner = new PassThrough()
  const toHost = new PassThrough()
  const refusals: Array<{ code: number; kind: unknown; message: string }> = []
  const connection = new RunnerConnection({ input: toHost, output: toRunner }, { holds_asks: true, elicitation: false, partial_rows: false }, {
    onRow: () => {},
    onAsk: () => ({ answer: Promise.resolve({ outcome: 'deny' as const }), withdraw: () => {} }),
    onApplied: () => {},
    onProtocolError: error => refusals.push({ code: error.code, kind: (error.data as { kind?: unknown } | undefined)?.kind, message: error.message }),
    log: () => {},
  })
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '0', pid: 1 }, session_id: 's' }))
  await connection.initialized
  runner.notify('row', { type: 'session', seq: 1, ...stamp('s'), schema: 2, mode: 'default', model: 'm', cwd: home, tools: [] } as never)
  await tick()
  check('one typed refusal reaches the daemon', refusals.length === 1 && refusals[0]!.code === RPC_REFUSED && refusals[0]!.kind === 'protocol', j(refusals))
  check('the refusal names the row and the schema the daemon reads', /session row schema 2/.test(refusals[0]?.message ?? '') && /expected 1/.test(refusals[0]?.message ?? ''), j(refusals[0]?.message))
  check('the connection is closed after it', connection.closed)
  const later = await connection.request('session/facts', {}).then(() => 'answered', (error: unknown) => (error instanceof Error ? error.name : String(error)))
  check('a later verb is refused typed (PeerClosed), never a hang', later === 'PeerClosed', later)
  runner.close('done')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-seat-protocol-refusal: ALL LAWS HOLD' : `prove-seat-protocol-refusal: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
