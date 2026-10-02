#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const dist = resolve(process.env.HELPERS_DIST ?? join(root, 'dist'))
const world = mkdtempSync(join(tmpdir(), 'hd-'))
const home = join(world, 'h')
const work = join(world, 'w')
for (const dir of [home, work, join(home, 'runtime')]) mkdirSync(dir, { recursive: true })
seedFirstRun(home, [work])
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_CONCOURSE_WORKER']) delete process.env[key]
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_WARM_RUNNER: '0' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { daemonControlRpc, readControlKey, controlSockPath } = await import('../../src/daemon/controlSocket.ts')
const handoverMod = (await import('../../src/daemon/handover.ts')) as typeof import('../../src/daemon/handover.ts') & { predecessorSockPidOf?: (entry: string, plane?: string) => number | null }
const { forwardFrame, predecessorSockPath, renameSocketForPredecessor } = handoverMod
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const hostedMod = (await import('../../src/daemon/hostedCaller.ts')) as typeof import('../../src/daemon/hostedCaller.ts')
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): boolean => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return ok
}
const note = (label: string, detail: unknown = ''): void => {
  console.log(`[NOTE] ${label}${detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  do {
    if (await predicate()) return true
    await wait(100)
  } while (Date.now() < deadline)
  return predicate()
}
const helloRequest = { op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }
const rpc = (request: object, timeoutMs = 10_000) => daemonControlRpc(request as never, { timeoutMs })
const at = async (pid: number, request: object) => forwardFrame(predecessorSockPath(pid), JSON.stringify({ ...request, proto: MERCURY_DAEMON_PROTO, auth: await readControlKey() }), 3000)
const hello = async (pid?: number) => (pid === undefined ? rpc(helloRequest) : at(pid, helloRequest))
const children: ChildProcess[] = []
const logs = new Map<number, string>()
const planeDir = join(home, 'daemon')
const planeLink = join(planeDir, 'control.sock')
const deploy = (dir: string): void => {
  rmSync(join(home, 'runtime/current'), { force: true })
  symlinkSync(dir, join(home, 'runtime/current'))
}
const payload = (name: string): string => {
  const dir = join(world, name)
  mkdirSync(dir)
  copyFileSync(join(dist, 'mercury.mjs'), join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: name.repeat(12).slice(0, 40) }))
  return dir
}
const spawnHelper = (dir: string, extraEnv: Record<string, string | undefined> = {}): number => {
  const child = spawn('node', [join(dir, 'mercury.mjs'), 'daemon', 'run', work], { cwd: work, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const pid = child.pid!
  logs.set(pid, '')
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => logs.set(pid, logs.get(pid)! + data))
  return pid
}
const boot = async (dir: string, predecessor?: number): Promise<number> => {
  deploy(dir)
  const pid = spawnHelper(dir, { MERCURY_DAEMON_HANDOVER_FROM: predecessor === undefined ? undefined : String(predecessor) })
  const ready = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid === pid && h.ready })
  check(`helper ${basename(dir)} (pid ${pid}) serves the plane`, ready, logs.get(pid))
  if (!ready) throw new Error(`helper ${pid} did not start`)
  return pid
}
type Chat = { sid: string; pid: number; short: string }
const admit = async (): Promise<Chat> => {
  const result = await rpc({ op: 'sessionAdmit', workspaceDir: work, birthKey: randomUUID(), isolation: 'shared', bornBlank: true })
  if (!result.ok || !('sessionId' in result)) throw new Error(JSON.stringify(result))
  const sid = String(result.sessionId)
  await until(() => Object.values(readSessionWorkers()).some(r => r.sessionId === sid && r.pid !== undefined))
  const record = Object.values(readSessionWorkers()).find(r => r.sessionId === sid)!
  check(`chat ${record.runnerId} has its own live runner`, record.pid !== undefined && isProcessAlive(record.pid), record)
  return { sid, pid: record.pid!, short: record.runnerId }
}
const end = async (chat: Chat): Promise<void> => {
  const out = await rpc({ op: 'sessionControl', action: 'stop', sessionId: chat.sid, by: 'operator' })
  check(`chat ${chat.short} ends through Mercury`, out.ok && 'outcome' in out && out.outcome === 'applied', out)
  check(`its runner (pid ${chat.pid}) left`, await until(() => !isProcessAlive(chat.pid)), chat)
}
const answers = async (chat: Chat, timeoutMs = 5000): Promise<boolean> => {
  const facts = await rpc({ op: 'sessionControl', action: 'session-facts', sessionId: chat.sid, by: 'operator' }, timeoutMs)
  return facts.ok && 'outcome' in facts && facts.outcome === 'applied'
}
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const node = (path: string): { ino: number; kind: string } | null => {
  try {
    const st = lstatSync(path)
    return { ino: st.ino, kind: st.isSymbolicLink() ? 'link' : st.isSocket() ? 'socket' : 'other' }
  } catch {
    return null
  }
}
const cli = async (args: string[], dir: string, extraEnv: Record<string, string | undefined> = {}): Promise<{ code: number | null; text: string }> => {
  const child = spawn('node', [join(dir, 'mercury.mjs'), 'daemon', ...args], { cwd: work, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => (text += data))
  return new Promise(resolve => child.once('exit', code => resolve({ code, text })))
}
const helpersLine = (text: string): string => text.split('\n').filter(l => /^\s+helpers:|^\s+pid \d+:/.test(l)).join(' | ')
const listen = (path: string): Promise<net.Server> => new Promise((resolveServer, reject) => {
  const server = net.createServer(() => {})
  server.once('error', reject)
  server.listen(path, () => resolveServer(server))
})
const closeServer = (server: net.Server): Promise<void> => new Promise(resolveClose => server.close(() => resolveClose()))

try {
  console.log('§A a successor never renames the plane link: the link is the pid-socket design, nothing is on the path to move')
  {
    mkdirSync(planeDir, { recursive: true })
    const predecessor = 4242
    const sibling = 4343
    const predecessorSocket = await listen(predecessorSockPath(predecessor))
    const siblingSocket = await listen(predecessorSockPath(sibling))
    symlinkSync(basename(predecessorSockPath(sibling)), planeLink)
    const before = node(predecessorSockPath(predecessor))
    const moved = renameSocketForPredecessor(predecessor)
    const after = node(predecessorSockPath(predecessor))
    check("the predecessor's own socket is the same node after the successor's rename step — a socket, not the sibling's link", before !== null && after !== null && before.ino === after.ino && after.kind === 'socket', { before, after, moved })
    check("the plane link still points at the sibling's socket", present(planeLink) && node(planeLink)?.kind === 'link' && readlinkSync(planeLink) === basename(predecessorSockPath(sibling)), readdirSync(planeDir))
    check("the step reports the predecessor's socket as serving on its own path", moved === true, moved)
    await closeServer(predecessorSocket)
    await closeServer(siblingSocket)
    rmSync(planeLink, { force: true })
    for (const entry of readdirSync(planeDir)) if (entry.startsWith('control.sock')) rmSync(join(planeDir, entry), { force: true })
  }

  console.log('§B the fallback pid-socket name keeps the home hash, and one reader maps every spelling back to its pid')
  {
    const tmpPlane = `/${'t'.repeat(64)}/hermes-daemon-0123456789ab.sock`
    const homePlane = `/${'h'.repeat(75)}/daemon/control.sock`
    const pidOf = handoverMod.predecessorSockPidOf
    check('the reader exists', typeof pidOf === 'function')
    const longForm = (predecessorSockPath as (pid: number, plane?: string) => string)(54321, tmpPlane)
    check('a pid socket past the path limit under the shared temp directory carries the home hash in its name', basename(longForm) === '0123456789ab.54321.sock', longForm)
    check('…and the reader maps it back to its pid', pidOf?.(basename(longForm), tmpPlane) === 54321, longForm)
    check("…while another home's bare <pid>.sock in that directory is not read as this home's", pidOf?.('54321.sock', tmpPlane) === null && pidOf?.('fedcba987654.54321.sock', tmpPlane) === null)
    const homeForm = (predecessorSockPath as (pid: number, plane?: string) => string)(54321, homePlane)
    check("in the home's own daemon directory the short form stays <pid>.sock and reads back", basename(homeForm) === '54321.sock' && pidOf?.(basename(homeForm), homePlane) === 54321, homeForm)
    check('the usual form reads back under both planes', pidOf?.('control.sock.777', homePlane) === 777 && pidOf?.('hermes-daemon-0123456789ab.sock.777', tmpPlane) === 777 && pidOf?.('control.sock', homePlane) === null && pidOf?.('control.key', homePlane) === null)
  }

  console.log('§C two successors of one hosting helper race for the plane: the older helper keeps its door and its chat stays reachable (the spawn skew scans the window)')
  const pDir = payload('p')
  let plane = await boot(pDir)
  const hosted: Array<{ helper: number; chat: Chat }> = []
  const skews = [0, 6, 12, 18, 24, 30]
  const race = process.env.DOORS_RACE !== '0'
  for (let round = 1; round <= skews.length; round++) {
    const chat = await admit()
    hosted.push({ helper: plane, chat })
    const door = predecessorSockPath(plane)
    const before = node(door)
    const xDir = payload(`x${round}`)
    deploy(xDir)
    const x = spawnHelper(xDir, { MERCURY_DAEMON_HANDOVER_FROM: String(plane) })
    const decided = (pid: number): boolean => /took the plane|standing down|refusing/.test(logs.get(pid) ?? '')
    let winner = x
    if (race) {
      await wait(skews[round - 1]!)
      const y = spawnHelper(payload(`y${round}`), { MERCURY_DAEMON_HANDOVER_FROM: String(plane) })
      check(`round ${round}: both successors decided`, await until(() => decided(x) && decided(y), 20_000), { x: logs.get(x), y: logs.get(y) })
      const winnerServes = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.ready && (h.pid === x || h.pid === y) }, 20_000)
      check(`round ${round}: one successor serves the plane`, winnerServes)
      const loserGone = await until(() => !isProcessAlive(x) || !isProcessAlive(y), 45_000)
      winner = isProcessAlive(x) ? x : y
      const loser = winner === x ? y : x
      note(`round ${round} (skew ${skews[round - 1]} ms): winner ${winner}, loser ${loser} left=${loserGone}; X took at ${(logs.get(x) ?? '').match(/^(\S+) \[daemon\] handover from pid \d+: took/m)?.[1] ?? '?'} up at ${(logs.get(x) ?? '').match(/^(\S+) \[daemon\] control socket up/m)?.[1] ?? '?'}; Y took at ${(logs.get(y) ?? '').match(/^(\S+) \[daemon\] handover from pid \d+: took/m)?.[1] ?? '?'}`)
    } else {
      check(`round ${round}: the successor decided`, await until(() => decided(x), 20_000), logs.get(x))
    }
    const planeServed = await until(async () => { const h = await hello(); return h.ok && h.op === 'hello' && h.pid === winner && h.ready }, 60_000)
    check(`round ${round}: the plane serves the winner once the loser is gone`, planeServed, await hello())
    const after = node(door)
    check(`round ${round}: the superseded helper's own socket is the same node, a socket and not a link`, before !== null && after !== null && before.ino === after.ino && after.kind === 'socket', { before, after, dir: readdirSync(planeDir) })
    for (const h of hosted) check(`round ${round}: the chat ${h.chat.short} hosted by pid ${h.helper} still answers through the plane`, await answers(h.chat), { helper: h.helper, alive: isProcessAlive(h.helper) })
    const status = await cli(['status'], xDir)
    check(`round ${round}: status counts every superseded helper with its one chat`, hosted.every(h => status.text.includes(`pid ${h.helper}: 1 live workers`)) && !status.text.includes('unknown'), helpersLine(status.text))
    plane = winner
  }

} catch (error) {
  check('the drive completes', false, String(error))
} finally {
  await rpc({ op: 'shutdown', reapWorkers: true }).catch(() => undefined)
  for (const child of children) {
    if (child.pid && isProcessAlive(child.pid)) await at(child.pid, { op: 'shutdown', reapWorkers: true }).catch(() => undefined)
  }
  check('every helper this drive started has left through Mercury', await until(() => children.every(child => !child.pid || !isProcessAlive(child.pid))), children.filter(child => child.pid && isProcessAlive(child.pid)).map(child => child.pid))
  for (const [pid, log] of logs) writeFileSync(join(world, `${pid}.log`), log)
  console.log(`world: ${world}`)
  if (failures === 0) rmSync(world, { recursive: true, force: true })
}
console.log(`prove-helper-doors: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`)
process.exitCode = failures === 0 ? 0 : 1
