#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture } from '../lib/scriptedTurn.ts'

const root = resolve(import.meta.dir, '../..')
const dist = resolve(process.env.HELPERS_DIST ?? join(root, 'dist'))
const world = mkdtempSync(join(tmpdir(), 'hr-'))
const home = join(world, 'h')
const work = join(world, 'w')
for (const dir of [home, work, join(home, 'runtime')]) mkdirSync(dir, { recursive: true })
symlinkSync(dist, join(home, 'runtime/current'))
seedFirstRun(home, [work])
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_CONCOURSE_WORKER']) delete process.env[key]
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_WARM_RUNNER: '0', MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const release = join(work, 'release')
const started = join(work, 'started')
const body = `const fs=require('node:fs'); const release=${JSON.stringify(release)}; const started=${JSON.stringify(started)}; const w=fs.watch(${JSON.stringify(work)},()=>{ if(fs.existsSync(release)){w.close(); console.log('work finished by the fixture');} }); fs.writeFileSync(started,'ready'); if(fs.existsSync(release)){w.close(); console.log('work finished by the fixture');}`
const command = `node -e '${body.replace(/'/g, `'\\''`)}'`
const fixture = await startScriptedFixture(req => req.step === 0 && req.ask.includes('hold helper turn')
  ? [{ type: 'tool_use', name: 'Bash', input: { command, description: 'wait for the fixture to finish its work' } }]
  : [{ type: 'text', text: 'the turn finished without interruption' }])
process.env.ANTHROPIC_BASE_URL = fixture.base
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  do {
    if (await predicate()) return true
    await wait(100)
  } while (Date.now() < deadline)
  return predicate()
}
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const rpc = (request: object) => daemonControlRpc(request as never, { timeoutMs: 10_000 })
const hello = () => rpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null })
const cli = async (verb: string): Promise<{ code: number | null; text: string }> => {
  const child = spawn('node', [join(dist, 'mercury.mjs'), 'daemon', verb], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => text += data)
  return new Promise(resolve => child.once('exit', code => resolve({ code, text })))
}
const children: ChildProcess[] = []
const logs = new Map<number, string>()
const boot = async (label: string): Promise<number> => {
  const child = spawn('node', [join(dist, 'mercury.mjs'), 'daemon', 'run', work], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const pid = child.pid!
  logs.set(pid, '')
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => logs.set(pid, logs.get(pid)! + data))
  const ready = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.ready && h.pid === pid })
  check(`${label} serves`, ready, logs.get(pid))
  if (!ready) throw new Error(`helper ${pid} did not start`)
  return pid
}
const admit = async (): Promise<{ sid: string; pid: number }> => {
  const result = await rpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true })
  if (!result.ok || !('sessionId' in result)) throw new Error(JSON.stringify(result))
  const sid = String(result.sessionId)
  await until(() => Object.values(readSessionWorkers()).some(r => r.sessionId === sid && r.pid !== undefined))
  const record = Object.values(readSessionWorkers()).find(r => r.sessionId === sid)!
  check('a chat has its own live runner', record.pid !== undefined && isProcessAlive(record.pid), record)
  return { sid, pid: record.pid! }
}
const end = async (chat: { sid: string; pid: number }): Promise<void> => {
  const out = await rpc({ op: 'sessionControl', action: 'stop', sessionId: chat.sid, by: 'operator' })
  check('the chat ends through Mercury', out.ok && 'outcome' in out && out.outcome === 'applied', out)
  check('its runner left', await until(() => !isProcessAlive(chat.pid)), chat)
}
const stopPlane = async (label: string): Promise<void> => {
  const stopped = await cli('stop')
  check(`${label} stops through Mercury`, stopped.code === 0 && await until(async () => !(await rpc({ op: 'ping' })).ok), stopped)
}
try {
  console.log('§A a chat mid-turn across `mercury daemon restart`: the work finishes, nothing is cut, the words are kept')
  const held = await boot('the scratch helper')
  const dispatched = await rpc({ op: 'sessionDispatch', workspaceDir: work, clientMessageId: randomUUID(), prompt: 'hold helper turn until the fixture releases it', permissionMode: 'sovereign' })
  if (!dispatched.ok || !('sessionId' in dispatched)) throw new Error(JSON.stringify(dispatched))
  const sid = String(dispatched.sessionId)
  check('the live turn reached its real Bash work', await until(() => existsSync(started), 60_000), logs.get(held))
  const record = () => Object.values(readSessionWorkers()).find(r => r.sessionId === sid)
  const runnerPid = record()?.pid
  const restart = await cli('restart')
  console.log(restart.text.trim())
  check('restart says it waits for the live session', restart.code === 0 && restart.text.includes('restarts when its 1 live session finish'), restart)
  const observeUntil = Date.now() + 22_000
  await until(() => Date.now() >= observeUntil || !isProcessAlive(held) || !isProcessAlive(runnerPid!), 25_000)
  const stillHeld = await hello()
  check('past the reported 18-second cut, the same helper and its working runner still live', stillHeld.ok && stillHeld.op === 'hello' && stillHeld.pid === held && stillHeld.restartArmed && stillHeld.live === 1 && runnerPid !== undefined && isProcessAlive(runnerPid) && !existsSync(release), stillHeld)
  writeFileSync(release, 'finish now')
  check('the actual work returns to the model and the turn finishes', await until(() => fixture.requests.some(req => req.results.some(result => result.text.includes('work finished by the fixture'))) && (record()?.lastTurnSettledAt ?? 0) >= (record()?.lastDeliveryAt ?? Infinity), 60_000), fixture.requests.map(req => ({ step: req.step, results: req.results.map(r => r.text.slice(0, 120)) })))
  check('finishing a turn does not close its chat or cut its next turn', isProcessAlive(held) && runnerPid !== undefined && isProcessAlive(runnerPid) && record()?.stoppedAt === undefined && record()?.endedAt === undefined, record())
  const stopped = await rpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'operator' })
  check('the chat closes through Mercury', stopped.ok, stopped)
  check('the waiting restart runs only after the chat closes', await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid !== held && h.ready && h.live === 0 }), logs.get(held))
  const next = await hello()
  check('the replacement answers as the same build', next.ok && next.op === 'hello' && next.buildTree === JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).buildTree?.slice(0, 12), next)
  check("the old helper's log names the armed restart and its idle moment, never a cut", /restart armed by mercury daemon restart — re-executes as the deployed build when the 1 live worker\(s\) finish/.test(logs.get(held) ?? '') && /armed restart — idle now, re-executing as the deployed build/.test(logs.get(held) ?? '') && !/drain ceiling|was still mid-turn/.test(logs.get(held) ?? ''), logs.get(held))
  await stopPlane('the replacement')

  console.log('§B two open chats across `mercury daemon restart`: the restart stays armed until the last one ends')
  const pid = await boot('a fresh helper')
  const one = await admit()
  const two = await admit()
  const armed = await cli('restart')
  console.log(armed.text.trim())
  check('the restart truthfully says it waits for both live chats', armed.code === 0 && armed.text.includes('restarts when its 2 live sessions finish'), armed)
  const deadline = Date.now() + 22_000
  check('past 18 seconds both chats and their helper are still alive', await until(async () => {
    if (!isProcessAlive(pid) || !isProcessAlive(one.pid) || !isProcessAlive(two.pid)) return true
    return Date.now() >= deadline
  }, 25_000) && isProcessAlive(pid) && isProcessAlive(one.pid) && isProcessAlive(two.pid), logs.get(pid))
  await end(one)
  check('the restart stays armed for the remaining chat', await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid === pid && h.live === 1 && h.restartArmed }), await hello())
  await end(two)
  check('only after the last chat ends does the successor take the plane', await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid !== pid && h.ready && h.live === 0 }), await hello())
  await stopPlane('the successor')

  console.log('§C a restart with nothing live proceeds at once')
  const idle = await boot('an idle helper')
  const idleRestart = await cli('restart')
  console.log(idleRestart.text.trim())
  check('a restart with nothing live restarts the helper now and says so', idleRestart.code === 0 && idleRestart.text.includes('daemon restarted') && !isProcessAlive(idle), idleRestart)
  check('its replacement serves', await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid !== idle && h.ready }), await hello())
  await stopPlane('the idle replacement')
} catch (error) {
  check('the drive completes', false, String(error))
} finally {
  writeFileSync(release, 'finish now')
  await cli('stop')
  await until(async () => !(await rpc({ op: 'ping' })).ok)
  check('every helper this drive started has left through Mercury', await until(() => children.every(child => !child.pid || !isProcessAlive(child.pid))), children.map(child => child.pid))
  await fixture.close()
  for (const [pid, log] of logs) writeFileSync(join(world, `${pid}.log`), log)
  console.log(`world: ${world}`)
  if (failures === 0) rmSync(world, { recursive: true, force: true })
}
console.log(`prove-helper-restart: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`)
process.exitCode = failures === 0 ? 0 : 1
