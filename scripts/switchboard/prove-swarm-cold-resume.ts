import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import { DIST, NODE, makeWorld, closeWorld, findFiles, record, toolResultOf } from '../crew/crew-world.ts'
import { startDaemonClientBeat } from '../lib/daemonClientBeat.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const model = 'claude-fable-5-1', childModel = 'claude-opus-4-6'
const world = await makeWorld('swarm-cold-resume', [
  { kind: 'tool_use', name: 'CrewBoard', id: 'cold-wait', input: { op: 'post', clientOpId: 'cold-wait', kind: 'ask', text: '@main wake me when about cold-trigger' }, whenModel: 'opus-4-6', model: childModel },
  { kind: 'text', text: 'COLD-CHILD-PARKED', whenModel: 'opus-4-6', model: childModel },
  { kind: 'text', text: 'COLD-CHILD-WOKE', whenModel: 'opus-4-6', model: childModel },
  { kind: 'tool_use', name: 'Crewmate', id: 'cold-launch', input: { name: 'cold-target', description: 'Wait across a runner restart', prompt: 'Declare the board wait and finish.', crewmate_type: 'mercury-crew', run_in_background: true, model: childModel, effort: 'max' }, whenModel: 'fable-5-1', model },
  ...Array.from({ length: 20 }, () => ({ kind: 'text' as const, text: 'COLD-LEAD-IDLE', whenModel: 'fable-5-1', model })),
])
writeFileSync(join(world.config, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
process.env.MERCURY_CONFIG_DIR = world.config
process.env.MERCURY_DAEMON_DIR = world.env.MERCURY_DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const beat = startDaemonClientBeat()
let daemon: ChildProcess | undefined, stopped: Promise<number | null> | undefined, log = '', sessionId = ''
let board: ReturnType<typeof open> | undefined
const until = async (label: string, predicate: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!await predicate()) {
    assert(Date.now() < deadline, `${label}\n${log.slice(-3000)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const workers = () => Object.values(readSessionWorkers(world.env.MERCURY_DAEMON_DIR))
const owned = () => workers().find(worker => worker.sessionId === sessionId && worker.endedAt === undefined)
const start = async () => {
  daemon = spawn(NODE, [DIST, 'daemon', 'run', world.project], { cwd: world.project, env: { ...world.env, MERCURY_DAEMON_NO_SELF_WARM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.stdout!.on('data', chunk => { log += String(chunk) })
  daemon.stderr!.on('data', chunk => { log += String(chunk) })
  stopped = new Promise(resolve => daemon!.once('exit', resolve))
  await until('the fixture daemon serves', async () => { try { return (await daemonControlRpc({ op: 'ping' }, { timeoutMs: 500 })).ok === true } catch { return false } })
}
const stop = async () => {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return
  daemon.kill('SIGTERM')
  const timer = setTimeout(() => daemon?.kill('SIGKILL'), 10_000)
  try { await stopped } finally { clearTimeout(timer) }
}
let serial = 0
const dispatch = async (prompt: string) => {
  const result = await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: `cold-${++serial}`, prompt, workspaceDir: world.project, model, effort: 'max', permissionMode: 'sovereign', bypassConsent: true, ...(sessionId ? { targetSessionId: sessionId } : {}) } as never, { timeoutMs: 60_000 }) as { ok: boolean; sessionId?: string }
  assert(result.ok, JSON.stringify(result))
  if (!sessionId) { assert(result.sessionId); sessionId = result.sessionId }
}
const childRequests = () => world.fixture.messageRequests().filter(request => (request.body as { model?: string }).model === childModel)
try {
  await start()
  const birth = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: world.project, isolation: 'shared', model, effort: 'max', permissionMode: 'sovereign', bypassConsent: true, bornBlank: true, runnerArgv: ['--allowed-tools', 'Crewmate', 'CrewBoard', 'Bash'], by: 'operator' } as never, { timeoutMs: 60_000 }) as { ok: boolean; sessionId?: string }
  assert(birth.ok && birth.sessionId, JSON.stringify(birth))
  sessionId = birth.sessionId
  assert((await daemonControlRpc({ op: 'sessionControl', action: 'focus', sessionId, by: `operator:${process.pid}` } as never)).ok)
  await dispatch('/swarm on')
  await until('the wave opens', () => findFiles(world.config, 'board.sqlite').length === 1)
  const path = findFiles(world.config, 'board.sqlite')[0]!
  assert.equal(basename(dirname(dirname(dirname(path)))), sessionId)
  board = open(path, sessionId)
  await dispatch('/swarmchat all')
  await until('the chat selection commits', () => board!.chat().on)
  await dispatch('/crewmates on')
  await dispatch('Launch the waiting child.')
  await until('the child wait is durably parked', () => toolResultOf(world, 'cold-wait') !== null && board!.seats().some(seat => seat.name === 'cold-target' && seat.state === 'parked' && seat.wait !== undefined))
  const target = board.seats().find(seat => seat.name === 'cold-target')!
  const beforeRequests = childRequests().length
  const prefix = board.screenEvents(0)
  const chat = board.chat()
  const oldPid = owned()?.pid
  assert(oldPid && oldPid !== process.pid)
  const metaPath = findFiles(world.config, `agent-${target.agent}.meta.json`)[0]!
  assert(metaPath)
  const metadata = readFileSync(metaPath, 'utf8')
  const transcript = join(dirname(dirname(dirname(path))), '..', `${sessionId}.jsonl`)
  assert(existsSync(transcript))
  const beforeTranscript = readFileSync(transcript, 'utf8')
  await stop()
  await until('the stopped daemon releases its runner', () => { try { process.kill(oldPid, 0); return false } catch { return true } })
  assert.deepEqual(board.seats().find(seat => seat.agent === target.agent)?.wait, target.wait)
  assert.deepEqual(board.chat(), chat)
  assert.deepEqual(board.screenEvents(0), prefix)
  assert.equal(readFileSync(metaPath, 'utf8'), metadata)
  console.log('PASS a daemon stop retains the board, parked arm, child metadata and chat selection')

  const sender = { author: { sessionId, agentId: 'cold-poster', executionId: 'poster' }, name: 'cold-poster' }
  board.enroll(sender)
  const trigger = board.post(sender, { clientOpId: 'cold-trigger', kind: 'result', about: 'cold-trigger', text: 'COLD-WAKE-PACKET' })
  assert(trigger.ok)
  assert.equal(board.pendingWakes().find(wake => wake.agent === target.agent)?.eventId, trigger.eventId)
  await start()
  const resumed = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: world.project, resumeSessionId: sessionId, isolation: 'shared', by: 'operator' } as never, { timeoutMs: 60_000 }) as { ok: boolean }
  assert(resumed.ok, JSON.stringify(resumed))
  await until('the cold session has a new runner', () => owned()?.pid !== undefined && owned()?.pid !== oldPid)
  const resumedPid = owned()!.pid
  const reattached = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: world.project, resumeSessionId: sessionId, isolation: 'shared', by: 'operator' } as never, { timeoutMs: 60_000 }) as { ok: boolean; liveHop?: boolean }
  assert(reattached.ok && reattached.liveHop, JSON.stringify(reattached))
  assert.equal(owned()?.pid, resumedPid)
  assert.deepEqual(board.chat(), chat)
  assert(readFileSync(transcript, 'utf8').startsWith(beforeTranscript))
  await dispatch('Continue the existing wave after the restart.')
  await until('the pending match resumes its original child once', () => board!.view().peerTurns === 1 && board!.screenEvents(0).some(event => event.author.agentId === target.agent && event.lifecycle?.kind === 'done'))
  const resumedRequests = childRequests().slice(beforeRequests)
  assert(resumedRequests.length)
  const request = resumedRequests[0]!.body as { messages: unknown; output_config?: { effort?: string } }
  const wire = JSON.stringify(request.messages)
  assert(wire.includes('COLD-CHILD-PARKED'))
  assert.equal(wire.split('COLD-WAKE-PACKET').length, 2)
  assert.equal(request.output_config?.effort, 'max')
  assert.equal(board.view().peerTurns, 1)
  assert.equal(board.seats().filter(seat => seat.name === 'cold-target').length, 1)
  assert.equal(board.seats().find(seat => seat.agent === target.agent)?.wait, undefined)
  assert.equal(board.screenEvents(0).filter(event => event.eventId === trigger.eventId).length, 1)
  const creations = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.updates === undefined && row.payload?.noticeKind === 'crew_chat')
  assert.equal(new Set(creations.map(row => row.recordId)).size, creations.length)
  assert.equal(creations.filter(row => row.payload.content === 'Swarm launched').length, 1)
  console.log('PASS cold resume and live reattach retain one wave, one launch row and one matched child continuation at max effort')
} finally {
  record('swarm-cold-resume-daemon.txt', log)
  record('swarm-cold-resume-requests.json', JSON.stringify(world.fixture.messageRequests().map(request => request.body)))
  if (board) record('swarm-cold-resume-board.json', JSON.stringify(board.view()))
  if (sessionId) { try { await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId, by: 'operator' } as never, { timeoutMs: 15_000 }) } catch {} }
  await stop()
  beat.stop()
  board?.close()
  await closeWorld(world)
}
