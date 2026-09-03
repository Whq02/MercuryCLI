#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-starting-door.ts — the readiness HOLD at the daemon's
//  door: a keyed WORK op that arrives while the daemon adopts its records /
//  acquires its lock is held until readiness (bounded by the adoption
//  budget), never refused on the spot; an adoption that never completes is
//  refused typed, naming the wait; the polls and the handshake keep their
//  prompt answers.
//
//    A  a dispatch issued during adoption is ADMITTED once ready (the answer
//       is the door's own, and it lands after the flip)
//    B  an adoption that never completes refuses ESTARTING within the hold,
//       naming the wait
//    C  a poll (status) during adoption refuses ESTARTING at once
//    D  hello during adoption still answers at once with ready:false
//    E  the hold sits under the work doors' round-trip deadlines, and the
//       host wakes it beside its own ready flip (source)
//
//  Driven on the REAL control server with fake deps (the wire prover's
//  harness). Run: ~/.bun/bin/bun run scripts/daemon/prove-starting-door.ts
// ============================================================================
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'starting-door-'))
const DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CONFIG_DIR = join(home, '.mercury')
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
for (const d of [process.env.MERCURY_CONFIG_DIR, DAEMON_DIR]) mkdirSync(d!, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const sock = await import('../../src/daemon/controlSocket.ts')
const server = await import('../../src/daemon/controlServer.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')

function rawRequest(path: string, frame: Record<string, unknown>, timeoutMs = 6000): Promise<Record<string, unknown> & { __ms: number }> {
  const started = Date.now()
  return new Promise(resolve => {
    const c = net.createConnection(path)
    const chunks: Buffer[] = []
    const t = setTimeout(() => {
      c.destroy()
      resolve({ __timeout: true, __ms: Date.now() - started })
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(frame)}\n`))
    c.on('data', b => {
      chunks.push(b)
      const joined = Buffer.concat(chunks)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      clearTimeout(t)
      c.destroy()
      try {
        resolve({ ...(JSON.parse(joined.subarray(0, nl).toString('utf8')) as Record<string, unknown>), __ms: Date.now() - started })
      } catch {
        resolve({ __bad: true, __ms: Date.now() - started })
      }
    })
    c.on('error', () => {
      clearTimeout(t)
      resolve({ __err: true, __ms: Date.now() - started })
    })
  })
}

const dispatchOk = { ok: true as const, clientMessageId: 'cm-1', state: 'queued', stateRevision: 1, runnerId: 'w1', sessionId: 's1', replay: 'dispatched' }
const fakeRoster = { list: () => [], has: () => ({ present: false }), liveCount: () => 0, totalCount: () => 0, getSupervisorState: () => ({ degraded: false }), liveWorkerFacts: () => [] }
const base = { proto: MERCURY_DAEMON_PROTO, auth: 'k' }

async function startServer(opts: { ready: () => boolean; whenReady?: () => Promise<void>; startingHoldMs?: number; dir: string }) {
  mkdirSync(opts.dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = opts.dir
  const deps = {
    roster: fakeRoster,
    breaker: { record: () => {}, state: () => 'closed' },
    dir: opts.dir,
    startedAt: Date.now(),
    maxInflight: 1,
    controlKey: 'k',
    isReady: opts.ready,
    ...(opts.whenReady ? { whenReady: opts.whenReady } : {}),
    ...(opts.startingHoldMs !== undefined ? { startingHoldMs: opts.startingHoldMs } : {}),
    onShutdown: () => ({ reaped: 0, workers: [] }),
    concourseDispatch: async () => dispatchOk,
  }
  const handle = await server.startControlServer(deps as unknown as Parameters<typeof server.startControlServer>[0])
  return handle
}
/** The path the server just bound (controlSockPath reads the plane dir set by startServer). */
const sockPathOf = (_dir: string): string => sock.controlSockPath()

console.log('\n── A · a dispatch issued during adoption is admitted once ready ──')
{
  const dir = join(home, 'a')
  let ready = false
  let wake: () => void = () => {}
  const readyPromise = new Promise<void>(resolve => {
    wake = resolve
  })
  const handle = await startServer({ dir, ready: () => ready, whenReady: () => readyPromise })
  const flipAt = Date.now() + 300
  setTimeout(() => {
    ready = true
    wake()
  }, 300)
  const reply = await rawRequest(sockPathOf(dir), { ...base, op: 'sessionDispatch', clientMessageId: 'cm-1', prompt: 'hi', workspaceDir: '/ws' })
  check('A1 the dispatch is ADMITTED (the door answers with its own result, never ESTARTING)', reply.ok === true && reply.replay === 'dispatched' && reply.runnerId === 'w1', JSON.stringify(reply))
  check('A2 …and the answer landed after the readiness flip (held, not raced)', reply.__ms >= 280 && Date.now() >= flipAt, `${reply.__ms}ms`)
  await handle.close?.()
}

console.log('\n── B · an adoption that never completes refuses typed within the hold ──')
{
  const dir = join(home, 'b')
  const handle = await startServer({ dir, ready: () => false, startingHoldMs: 300 })
  const reply = await rawRequest(sockPathOf(dir), { ...base, op: 'sessionDispatch', clientMessageId: 'cm-2', prompt: 'hi', workspaceDir: '/ws' })
  check('B1 the refusal is the typed ESTARTING', reply.ok === false && reply.code === 'ESTARTING', JSON.stringify(reply))
  check('B2 …naming the wait it held', /held 300ms/.test(String(reply.error)), String(reply.error))
  check('B3 …inside the hold (bounded — never a hang, never a caller-side timeout)', reply.__ms >= 280 && reply.__ms < 1500, `${reply.__ms}ms`)
  await handle.close?.()
}

console.log('\n── C · a poll during adoption refuses at once ──')
{
  const dir = join(home, 'c')
  const handle = await startServer({ dir, ready: () => false })
  const status = await rawRequest(sockPathOf(dir), { ...base, op: 'status' })
  check('C1 status answers ESTARTING promptly (a poll asks what is; its caller allows a second)', status.ok === false && status.code === 'ESTARTING' && status.__ms < 500, `${status.__ms}ms ${JSON.stringify(status)}`)
  const list = await rawRequest(sockPathOf(dir), { ...base, op: 'sessionList' })
  check('C2 list answers ESTARTING promptly too', list.ok === false && list.code === 'ESTARTING' && list.__ms < 500, `${list.__ms}ms`)
  await handle.close?.()
}

console.log('\n── D · hello during adoption still answers at once, ready:false ──')
{
  const dir = join(home, 'd')
  const handle = await startServer({ dir, ready: () => false, startingHoldMs: 2000 })
  const hello = await rawRequest(sockPathOf(dir), { op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '0' })
  check('D1 hello is not held (ready:false, at once)', hello.ok === true && hello.ready === false && hello.__ms < 500, `${hello.__ms}ms ${JSON.stringify(hello).slice(0, 120)}`)
  await handle.close?.()
}

console.log('\n── E · the hold sits under the work doors\' deadlines; the host wakes it at its ready flip ──')
{
  check('E1 the hold is far under the connector\'s round-trip deadline (15s) and the seat\'s (10s)', server.ESTARTING_HOLD_MS > 0 && server.ESTARTING_HOLD_MS <= 5_000, String(server.ESTARTING_HOLD_MS))
  const mainSrc = read('src/daemon/main.ts')
  const readyAt = mainSrc.indexOf('ready = true\n      wakeReady()')
  check('E2 the host wakes the hold beside its own ready flip and hands the wake to the server', readyAt !== -1 && mainSrc.includes('whenReady: () => readyPromise,'))
  const serverSrc = read('src/daemon/controlServer.ts')
  check('E3 the polls keep the prompt refusal (list · has · status)', serverSrc.includes("const PROMPT_WHILE_STARTING = new Set(['sessionList', 'list', 'has', 'status'])"))
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ starting-door — the work doors wait for readiness; the polls and the handshake answer at once' : `\n ❌ starting-door — ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
