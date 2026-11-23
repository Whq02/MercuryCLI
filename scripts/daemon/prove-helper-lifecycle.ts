#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { copyDistChunks } from '../lib/copyDistChunks.ts'

const root = resolve(import.meta.dir, '../..')
const dist = resolve(process.env.HELPERS_DIST ?? join(root, 'dist'))
const world = mkdtempSync(join(tmpdir(), 'hl-'))
const home = join(world, 'h')
const work = join(world, 'w')
for (const dir of [home, work, join(home, 'runtime')]) mkdirSync(dir, { recursive: true })
seedFirstRun(home, [work])
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_CONCOURSE_WORKER']) delete process.env[key]
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_WARM_RUNNER: '0' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { daemonControlRpc, readControlKey, controlSockPath } = await import('../../src/daemon/control/controlSocket.ts')
const { forwardFrame } = await import('../../src/daemon/control/handover.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { isProcessAlive } = await import('../../src/daemon/control/ownerWatch.ts')
const { formatMercuryDaemonStatus, getMercuryDaemonStatus, helperPidSocketsOnDisk } = await import('../../src/daemon/control/status.ts')
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = '', hint = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}${hint === '' ? '' : ` — ${hint}`}`}`)
}
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const budgetScale = Math.max(1, Number(process.env.MERCURY_VSHOT_BUDGET_SCALE ?? '1') || 1)
const until = async (predicate: () => boolean | Promise<boolean>, ms = 30_000 * budgetScale): Promise<boolean> => {
  const deadline = Date.now() + ms
  do {
    if (await predicate()) return true
    await wait(100)
  } while (Date.now() < deadline)
  return predicate()
}
const helloRequest = { op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }
const rpc = (request: object) => daemonControlRpc(request as never, { timeoutMs: 10_000 })
const at = async (pid: number, request: object) => forwardFrame(`${controlSockPath()}.${pid}`, JSON.stringify({ ...request, proto: MERCURY_DAEMON_PROTO, auth: await readControlKey() }), 3000)
const hello = async (pid?: number) => pid === undefined ? rpc(helloRequest) : at(pid, helloRequest)
const children: ChildProcess[] = []
const logs = new Map<number, string>()
const deploy = (dir: string): void => {
  rmSync(join(home, 'runtime/current'), { force: true })
  symlinkSync(dir, join(home, 'runtime/current'))
}
const payload = (name: string): string => {
  const dir = join(world, name)
  mkdirSync(dir)
  copyDistChunks(dist, dir)
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: name.repeat(12) }))
  return dir
}
const boot = async (dir: string, predecessor?: number): Promise<number> => {
  deploy(dir)
  const child = spawn('node', [join(dir, 'mercury.mjs'), 'daemon', 'run', work], { cwd: work, env: { ...process.env, MERCURY_DAEMON_HANDOVER_FROM: predecessor === undefined ? undefined : String(predecessor) }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const pid = child.pid!
  logs.set(pid, '')
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => logs.set(pid, logs.get(pid)! + data))
  const ready = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid === pid && h.ready })
  check(`helper ${dir.split('/').pop()} is ready`, ready, logs.get(pid), `the daemon started from ${dir} (mercury.mjs daemon run) did not answer hello as ready with its own pid: read its log above; HELPERS_DIST names the build under test, run \`bun run build.ts\` first`)
  if (!ready) throw new Error(`helper ${pid} did not start`)
  return pid
}
const admit = async (): Promise<{ sid: string; pid: number }> => {
  const result = await rpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true })
  if (!result.ok || !('sessionId' in result)) throw new Error(JSON.stringify(result))
  const sid = String(result.sessionId)
  const registered = await until(() => Object.values(readSessionWorkers()).some(r => r.sessionId === sid && r.pid !== undefined))
  const record = Object.values(readSessionWorkers()).find(r => r.sessionId === sid)
  check('a chat has its own live runner', registered && record?.pid !== undefined && isProcessAlive(record.pid), { registered, record, budgetMs: 30_000 * budgetScale }, 'a sessionAdmit should leave a runner recorded in readSessionWorkers (src/daemon/concourse-workers/concourseWorkers.ts) with a live pid; the helper logs are in the world folder printed at the end')
  if (record?.pid === undefined) throw new Error(`the admitted chat ${sid} has no runner record within ${30_000 * budgetScale} ms`)
  return { sid, pid: record.pid }
}
const end = async (chat: { sid: string; pid: number }): Promise<void> => {
  const out = await rpc({ op: 'sessionControl', action: 'stop', sessionId: chat.sid, by: 'operator' })
  check('the chat ends through Mercury', out.ok && 'outcome' in out && out.outcome === 'applied', out, "the stop action of sessionControl was not applied by the helper hosting this chat; see the helper's log in the world folder printed at the end")
  check('its runner left', await until(() => !isProcessAlive(chat.pid)), chat, 'the runner of the stopped chat is still alive: the stop action of sessionControl must end the runner process')
}
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const planeDir = join(home, 'daemon')
const cli = async (verb: string, dir: string): Promise<{ code: number | null; text: string }> => {
  const child = spawn('node', [join(dir, 'mercury.mjs'), 'daemon', verb], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout?.on('data', data => text += data)
  child.stderr?.on('data', data => text += data)
  return new Promise(resolve => child.once('exit', code => resolve({ code, text })))
}
try {
  console.log('The handover ladder: each helper owns only its own chats')
  const aDir = payload('a')
  const a = await boot(aDir)
  const a1 = await admit()
  const a2 = await admit()
  const bDir = payload('b')
  const b = await boot(bDir, a)
  const b1 = await admit()
  const bFacts = await hello()
  check('the new helper counts only its own one chat', bFacts.ok && bFacts.op === 'hello' && bFacts.live === 1 && bFacts.liveSessions === 1, bFacts, "the hello answer (built near liveSessions in src/daemon/control/controlServer.ts) must count only the helper's own chats, not those its predecessor hosts")
  check("the new helper's log says it keeps its predecessor's two chats, not the plane's total", await until(() => /keeps 2 live session\(s\) until they finish/.test(logs.get(b) ?? '')), logs.get(b), 'the handover line printed at boot in src/daemon/control/main.ts must count the sessions the predecessor holds')
  await end(a1)
  check('the old helper stays for its second chat', isProcessAlive(a) && isProcessAlive(a2.pid))
  const cDir = payload('c')
  const c = await boot(cDir, b)
  const c1 = await admit()
  check("the newest helper's log counts the one chat its predecessor hosts", await until(() => /keeps 1 live session\(s\) until they finish/.test(logs.get(c) ?? '')), logs.get(c), 'the handover line printed at boot in src/daemon/control/main.ts must count only the sessions the predecessor holds')
  const countBefore = await cli('status', cDir)
  check('status counts all three helpers and their separate chats', countBefore.text.includes('3 running / 3 live workers'), countBefore, 'the helpers line of the status text built in src/daemon/control/status.ts (getMercuryDaemonStatus, formatMercuryDaemonStatus) must count every helper and its chats')
  check('the plane is a link to the newest helper\'s own socket', lstatSync(join(planeDir, 'control.sock')).isSymbolicLink() && present(join(planeDir, `control.sock.${c}`)), readdirSync(planeDir), "the plane socket control.sock must be a symlink to the newest helper's control.sock.<pid> (the link is handled in src/daemon/control/controlServer.ts)")
  rmSync(join(planeDir, 'control.sock'))
  const onDisk = helperPidSocketsOnDisk()
  check('each helper has a socket of its own on disk, found with no plane at all', [a, b, c].every(pid => onDisk.includes(pid)), onDisk, 'helperPidSocketsOnDisk in src/daemon/control/status.ts must list every control.sock.<pid> in the plane folder')
  const unlinked = await getMercuryDaemonStatus()
  check('with the plane link gone, status still counts every helper and the chat each hosts through its own socket', unlinked.helpers?.length === 3 && [a, b].every(pid => unlinked.helpers?.some(helper => helper.pid === pid && helper.live === 1)) && unlinked.helpers?.some(helper => helper.pid === c), formatMercuryDaemonStatus(unlinked), 'getMercuryDaemonStatus in src/daemon/control/status.ts must find the helpers through their own sockets when the plane link is gone')
  check('the newest helper puts its plane link back on its own', await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid === c }, 45_000), readdirSync(planeDir), 'the newest helper must recreate the removed control.sock link by itself within 45 s (the link is handled in src/daemon/control/controlServer.ts)')
  const countHealed = await cli('status', cDir)
  check('status reads all three again once the link is back', countHealed.text.includes('3 running / 3 live workers'), countHealed, 'the helpers line of the status text in src/daemon/control/status.ts must count all three once the plane link is back')
  const bAfter = await hello(b)
  check('a superseded helper excludes both older and newer chats', bAfter.ok && bAfter.op === 'hello' && bAfter.live === 1, bAfter, 'the live count in the hello answer (src/daemon/control/controlServer.ts) of a superseded helper must hold only its own chats')
  await end(b1)
  check('the middle helper leaves at its own last chat, even while the first still hosts one', await until(() => !isProcessAlive(b), 45_000), logs.get(b), 'a superseded helper must exit once its own last chat ends, whatever older helpers still host; see its log')
  check('the earlier chat and newest helper are untouched', isProcessAlive(a) && isProcessAlive(a2.pid) && isProcessAlive(c) && isProcessAlive(c1.pid), { a: isProcessAlive(a), a2: isProcessAlive(a2.pid), c: isProcessAlive(c), c1: isProcessAlive(c1.pid) }, 'ending the middle helper must not touch another helper or its runners')
  const facts = await rpc({ op: 'sessionControl', action: 'session-facts', sessionId: a2.sid, by: 'operator' })
  check('the earliest chat stays reachable after the middle helper left', !isProcessAlive(b) && facts.ok, facts, 'the plane must still route sessionControl session-facts to the helper hosting that chat after the middle helper left')
  const countMiddle = await cli('status', cDir)
  check('status drops the departed middle helper, keeping both live chats', countMiddle.text.includes('2 running / 2 live workers'), countMiddle, 'the helpers line of the status text in src/daemon/control/status.ts must drop a helper that has left')
  await end(a2)
  check('the first helper leaves when its own last chat ends', await until(() => !isProcessAlive(a), 45_000), logs.get(a), 'the first helper must exit once its own last chat ends; see its log')
  const newest = await hello()
  check('the newest helper still serves its one chat', newest.ok && newest.op === 'hello' && newest.pid === c && newest.live === 1 && isProcessAlive(c1.pid), newest, 'the plane must answer from the newest helper with its one live chat')
  check('the departed helpers left no socket of their own behind', !present(join(planeDir, `control.sock.${a}`)) && !present(join(planeDir, `control.sock.${b}`)), readdirSync(planeDir), 'a helper that exits must remove its own control.sock.<pid> from the plane folder')
  await end(c1)
  const stopped = await cli('stop', cDir)
  check('the plane helper stops through Mercury', stopped.code === 0 && await until(() => !isProcessAlive(c)), stopped, 'the daemon stop verb (mercury daemon stop) must exit 0 and the helper must leave')
  const countAfter = await cli('status', cDir)
  check('the final status says zero helpers and zero live workers', countAfter.text.includes('0 running / 0 live workers'), countAfter, 'the helpers line of the status text in src/daemon/control/status.ts must read zero after the stop')
  check('the stopped plane left no socket or link behind', !present(join(planeDir, 'control.sock')) && !present(join(planeDir, `control.sock.${c}`)), readdirSync(planeDir), 'a stopped daemon must remove control.sock and its control.sock.<pid> from the plane folder')
} catch (error) {
  check('the drive completes', false, String(error), 'a step threw before its checks: the error names it, and the helper logs are in the world folder printed below')
} finally {
  await rpc({ op: 'shutdown', reapWorkers: true })
  for (const child of children) {
    if (child.pid && isProcessAlive(child.pid)) await at(child.pid, { op: 'shutdown', reapWorkers: true })
  }
  check('every directly started helper has left through Mercury', await until(() => children.every(child => !child.pid || !isProcessAlive(child.pid))), children.map(child => child.pid), 'a helper this drive started is still alive after a shutdown request; see its log in the world folder printed below')
  for (const [pid, log] of logs) writeFileSync(join(world, `${pid}.log`), log)
  console.log(`world: ${world}`)
  if (failures === 0) rmSync(world, { recursive: true, force: true })
}
console.log(`prove-helper-lifecycle: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`)
process.exitCode = failures === 0 ? 0 : 1
