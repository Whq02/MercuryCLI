#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const scratch = mkdtempSync(join(tmpdir(), 'demand-workers-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(work)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
seedFirstRun(home, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const fixture = await startFixtureApi([])
const dist = resolve('dist/mercury.mjs')
assert.ok(existsSync(dist), 'build the product before the drive')
const runtime = resolve('dist/vendor/node/bin/node')
let output = ''
const daemon = spawn(runtime, [dist, 'daemon', 'run', work], {
  cwd: work,
  env: { ...process.env, ANTHROPIC_BASE_URL: fixture.url, MERCURY_DAEMON_OWNER_PID: String(process.pid) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
daemon.stdout.on('data', b => { output += b })
daemon.stderr.on('data', b => { output += b })
let exited = false
const exit = new Promise<void>(r => daemon.once('exit', () => { exited = true; r() }))
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(predicate: () => Promise<boolean>, ms = 20_000): Promise<void> {
  let expired = false
  const deadline = setTimeout(() => { expired = true }, ms)
  try {
    while (!expired) {
      if (await predicate()) return
      assert.ok(!exited, output)
      await wait(40)
    }
    throw new Error(`observation expired: ${output}`)
  } finally { clearTimeout(deadline) }
}
const rows = (): Array<{ event?: string; kind: string; id: string; pid?: number }> => {
  const path = join(home, 'daemon', 'spawn-ledger.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
}
const births = () => rows().filter(r => r.event === undefined && r.kind === 'long-lived')
const exits = () => rows().filter(r => r.event === 'exit' && r.kind === 'long-lived')
type Status = { ok: boolean; status?: { workersLive: number; workersTotal: number; warmRunners?: number } }
const status = async (): Promise<Status['status']> => (await daemonControlRpc({ op: 'status' }, { timeoutMs: 2_000 }) as Status).status
let failure: unknown
try {
  await until(async () => (await daemonControlRpc({ op: 'ping' }, { timeoutMs: 500 })).ok)
  await until(async () => (await status()) !== undefined)
  const idle = await status()
  assert.equal(idle?.workersTotal, 0, `boot without demand rostered workers: ${JSON.stringify(idle)}`)
  assert.equal(births().length, 0, `boot without demand spawned workers: ${JSON.stringify(births())}`)
  console.log('PASS boot without demand creates zero workers (the roster reads 0 rostered, the ledger holds no birth)')
  for (let n = 1; n <= 3; n++) {
    const reply = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', bornBlank: true } as never, { timeoutMs: 20_000 }) as { ok: boolean; runnerId?: string; error?: string }
    assert.equal(reply.ok, true, JSON.stringify(reply))
    await until(async () => (await status())?.workersTotal === n)
    await until(async () => births().length >= n)
    assert.equal(births().length, n, `demand ${n} created a speculative spare`)
    assert.equal((await status())?.warmRunners ?? 0, 0, `demand ${n} left a warm spare beside the worker`)
    console.log(`PASS demand ${n} creates exactly its own worker (roster ${n} rostered, ledger ${n} birth(s), no warm spare)`)
  }
  assert.equal(fixture.messageRequests().length, 0, 'admission alone makes no inference request')
} catch (error) { failure = error }
const reaps = () => rows().filter(r => r.event === 'reap' && r.kind === 'long-lived')
const bornIds = births().map(b => b.id)
const bornShorts = bornIds.map(id => id.split('@')[0] ?? id)
const endedBy = (short: string, id: string) => reaps().some(r => r.id === short) || exits().some(r => r.id === id)
let endRowsSeen = false
try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => {})
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (bornIds.every((id, i) => endedBy(bornShorts[i]!, id))) { endRowsSeen = true; break }
    if (exited) break
    await wait(40)
  }
} finally {
  await Promise.race([exit, wait(10_000)])
  if (!exited) { daemon.kill('SIGTERM'); await Promise.race([exit, wait(5_000)]) }
  if (!exited) { daemon.kill('SIGKILL'); await exit }
  await fixture.close()
}
if (failure) { console.error(output); throw failure }
assert.ok(endRowsSeen, `the daemon left before every worker's end row landed: births ${JSON.stringify(bornIds)} reaps ${JSON.stringify(reaps().map(r => r.id))} exits ${JSON.stringify(exits().map(r => r.id))}`)
for (const [i, id] of bornIds.entries()) {
  const reaped = reaps().filter(r => r.id === bornShorts[i])
  assert.equal(reaped.length, 1, `worker ${id} has ${reaped.length} reap row(s); the daemon shutdown writes exactly one, synchronously, before it kills`)
  assert.ok(typeof reaped[0]?.pid === 'number', `reap row for ${id} names no pid`)
  assert.ok(String((reaped[0] as { reason?: string }).reason).startsWith('daemon-shutdown:'), `reap row for ${id} names no shutdown reason`)
  assert.ok(exits().filter(r => r.id === id).length <= 1, `worker ${id} wrote more than one exit row`)
}
console.log(`PASS every fixture worker is reaped with its daemon (one reap row per birth, read from the ledger before the daemon left; ${exits().length} exit(s) also observed)`)
rmSync(scratch, { recursive: true, force: true })
