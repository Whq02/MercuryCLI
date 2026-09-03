#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-rpc.ts
//  PROOF: the 'crewSpawn' control-socket op — REAL server + REAL client +
//  REAL key file in a scratch config home (production condition, no fakes on
//  the wire). Pins: auth is enforced (EAUTH), readiness gates (ESTARTING),
//  dep-absent answers ENOTSUP, shape errors EUNKNOWN, the dep receives
//  INTENT ONLY (name + model key — a key-authed caller can never widen a
//  spec), refusals pass through verbatim, and the default client auto-stamps
//  proto+auth for crewSpawn.
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-rpc.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const scratch = mkdtempSync(join(tmpdir(), 'crew-rpc-'))
process.env.MERCURY_CONFIG_DIR = scratch
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { startControlServer } = await import('../../src/daemon/controlServer.js')
const { mintControlKey, daemonControlRpc, controlSockPath } = await import('../../src/daemon/controlSocket.js')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.js')
const { DaemonBreaker } = await import('../../src/utils/daemonBreaker.js')
type DaemonRequest = import('../../src/daemon/protocol.js').DaemonRequest
type DaemonReply = import('../../src/daemon/protocol.js').DaemonReply
type TaskRoster = import('../../src/daemon/roster.js').TaskRoster
type Deps = import('../../src/daemon/controlServer.js').ControlServerDeps

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

console.log('============================================================')
console.log(' Crew spawn RPC (authed control-socket op) — proof')
console.log('============================================================')

// A raw one-shot client that sends EXACTLY the frame given (no auto-stamping)
// — the adversarial caller the auth check exists for.
function rawRpc(frame: Record<string, unknown>): Promise<DaemonReply> {
  return new Promise(resolve => {
    const sock = net.connect(controlSockPath())
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, code: 'ETIMEOUT', error: 'proof timeout' } as DaemonReply) }, 4000)
    sock.on('connect', () => sock.write(JSON.stringify(frame) + '\n'))
    sock.on('data', d => {
      buf += String(d)
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(timer)
        sock.destroy()
        try { resolve(JSON.parse(buf.slice(0, nl)) as DaemonReply) } catch { resolve({ ok: false, code: 'EUNKNOWN', error: 'unparseable' } as DaemonReply) }
      }
    })
    sock.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'ENOCONN', error: 'no listener' } as DaemonReply) })
  })
}

// The real TaskRoster is irrelevant to the crewSpawn path (the op touches only
// deps.crewSpawn + auth + readiness); a minimal stand-in keeps the server real.
const fakeRoster = { list: () => [], has: () => ({ present: false }) } as unknown as TaskRoster
const key = await mintControlKey()
const baseDeps = {
  roster: fakeRoster,
  breaker: new DaemonBreaker(),
  dir: scratch,
  startedAt: Date.now(),
  maxInflight: 1,
  controlKey: key,
  isReady: () => true,
  onShutdown: () => 0,
} satisfies Omit<Deps, 'crewSpawn' | 'nudgeAgent'>

section('server A — dep present: auth, intent-only relay, verbatim refusals')
{
  const calls: Array<unknown[]> = []
  const server = await startControlServer({
    ...baseDeps,
    crewSpawn: async (...args: [string, string]) => {
      calls.push(args)
      if (args[0] === 'reject') return { ok: false, error: 'cap reached (test refusal)' }
      return { ok: true, pid: 777 }
    },
  })

  const noAuth = await rawRpc({ op: 'crewSpawn', proto: MERCURY_DAEMON_PROTO, name: 'atlas', model: 'sonnet' })
  check('no auth ⇒ EAUTH (key required)', !noAuth.ok && 'code' in noAuth && noAuth.code === 'EAUTH')
  check('unauth call never reached the dep', calls.length === 0)

  const ok = await daemonControlRpc({ op: 'crewSpawn', name: 'atlas', model: 'sonnet' } as DaemonRequest, { timeoutMs: 3000 })
  check('default client (auto proto+auth) ⇒ ok', ok.ok === true && ok.ok && ok.op === 'crewSpawn')
  check('reply carries the worker pid', ok.ok && ok.op === 'crewSpawn' && ok.pid === 777)
  check('dep received INTENT ONLY: exactly (name, modelKey)', calls.length === 1 && calls[0]!.length === 2 && calls[0]![0] === 'atlas' && calls[0]![1] === 'sonnet')

  const misshapen = await rawRpc({ op: 'crewSpawn', proto: MERCURY_DAEMON_PROTO, auth: key, model: 'sonnet' })
  check('missing name ⇒ EUNKNOWN shape error', !misshapen.ok && 'code' in misshapen && misshapen.code === 'EUNKNOWN' && /requires/.test(misshapen.error ?? ''))
  check('shape error never reached the dep', calls.length === 1)

  const refused = await daemonControlRpc({ op: 'crewSpawn', name: 'reject', model: 'opus' } as DaemonRequest, { timeoutMs: 3000 })
  check('host refusal passes through VERBATIM', !refused.ok && refused.error === 'cap reached (test refusal)')

  await server.close()
}

section('server B — no crewSpawn dep: honest ENOTSUP')
{
  const server = await startControlServer({ ...baseDeps })
  const r = await daemonControlRpc({ op: 'crewSpawn', name: 'atlas', model: 'sonnet' } as DaemonRequest, { timeoutMs: 3000 })
  check('dep absent ⇒ ENOTSUP naming the gap', !r.ok && 'code' in r && r.code === 'ENOTSUP' && /does not host crew/.test(r.error ?? ''))
  await server.close()
}

section('server C — not ready: the work door HOLDS for the adoption budget, then refuses ESTARTING (the client retry key)')
{
  // The hold is the adoption's budget (ESTARTING_HOLD_MS in the product); the
  // proof seam shortens it so an adoption that outlives the hold refuses
  // inside the client's own deadline — typed, naming the wait.
  const server = await startControlServer({ ...baseDeps, isReady: () => false, startingHoldMs: 200, crewSpawn: async () => ({ ok: true, pid: 1 }) })
  const t0 = Date.now()
  const r = await daemonControlRpc({ op: 'crewSpawn', name: 'atlas', model: 'sonnet' } as DaemonRequest, { timeoutMs: 3000 })
  const waited = Date.now() - t0
  check('an adoption that outlives the hold ⇒ ESTARTING, typed, naming the wait (spawnCrewTeammate retries on exactly this)', !r.ok && 'code' in r && r.code === 'ESTARTING' && /held 200ms for readiness/.test(r.error ?? ''), JSON.stringify(r))
  check('…answered after the hold, never on the spot', waited >= 180, `${waited}ms`)
  await server.close()
}

section('server D — a boot race inside the hold: the dispatch is held and admitted once ready')
{
  let ready = false
  const flip = setTimeout(() => {
    ready = true
  }, 150)
  const server = await startControlServer({ ...baseDeps, isReady: () => ready, crewSpawn: async () => ({ ok: true, pid: 7 }) })
  const r = await daemonControlRpc({ op: 'crewSpawn', name: 'atlas', model: 'sonnet' } as DaemonRequest, { timeoutMs: 3000 })
  clearTimeout(flip)
  check('a dispatch during adoption is admitted once ready (never refused on the spot)', r.ok === true && (r as { pid?: number }).pid === 7, JSON.stringify(r))
  await server.close()
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW RPC PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW RPC PROOFS PASS')
