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
  {
    const pidAliveNow = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    const listed = ((await daemonControlRpc({ op: 'list' }, { timeoutMs: 2_000 })) as { jobs?: Array<{ short: string; pid?: number; outcome?: string }> }).jobs ?? []
    const first = listed.find(j => j.short === 'concourse-w1' && !j.outcome)
    assert.ok(first !== undefined && typeof first.pid === 'number' && pidAliveNow(first.pid), `the roster names a live pid for concourse-w1: ${JSON.stringify(listed)}`)
    const t0 = Date.now()
    const killed = (await daemonControlRpc({ op: 'kill', short: 'concourse-w1' } as never, { timeoutMs: 5_000 })) as { ok: boolean }
    assert.equal(killed.ok, true, 'the daemon accepted the kill of concourse-w1')
    let gone = false
    for (const t1 = Date.now(); Date.now() - t1 < 10_000 && !gone; ) { gone = !pidAliveNow(first!.pid!); if (!gone) await wait(40) }
    for (const t2 = Date.now(); Date.now() - t2 < 10_000 && !rows().some(r => r.event === 'exit' && r.id === 'concourse-w1@concourse'); ) await wait(40)
    const exitRow = rows().find(r => r.event === 'exit' && r.id === 'concourse-w1@concourse') as { outcome?: string; pid?: number } | undefined
    assert.ok(exitRow !== undefined && exitRow.outcome === 'killed' && exitRow.pid === first!.pid, `the killed worker's exit row reads killed with its pid while the daemon lives: ${JSON.stringify(exitRow)}`)
    assert.equal(((await daemonControlRpc({ op: 'status' }, { timeoutMs: 2_000 })) as Status).status?.workersLive, 2, 'the roster reads two live workers after one kill')
    console.log(`PASS a kill through the daemon ends the worker process itself within ${Date.now() - t0}ms while the daemon lives, and its exit row reads killed`)
  }
} catch (error) { failure = error }
const reaps = () => rows().filter(r => r.event === 'reap' && r.kind === 'long-lived')
const allBornIds = births().map(b => b.id)
const bornIds = allBornIds.filter(id => id !== 'concourse-w1@concourse')
const bornShorts = bornIds.map(id => id.split('@')[0] ?? id)
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const roster = failure ? [] : ((await daemonControlRpc({ op: 'list' }, { timeoutMs: 2_000 }).catch(() => ({ jobs: [] }))) as { jobs?: Array<{ short: string; pid?: number; outcome?: string }> }).jobs ?? []
const workerPids = bornShorts.map(short => roster.find(j => j.short === short && !j.outcome)?.pid).filter((p): p is number => typeof p === 'number')
const pidsAliveBefore = workerPids.filter(pidAlive)
const endedBy = (short: string, id: string) => reaps().some(r => r.id === short) || exits().some(r => r.id === id)
let endRowsSeen = false
let allPidsGone = false
let pidsGoneAtMs = -1
const STOP_DEADLINE_MS = 10_000
const KILL_BOUND_MS = 3_000
const shutdownAt = Date.now()
try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => {})
  const deadline = shutdownAt + STOP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (!endRowsSeen && bornIds.every((id, i) => endedBy(bornShorts[i]!, id))) endRowsSeen = true
    if (!allPidsGone && workerPids.every(p => !pidAlive(p))) { allPidsGone = true; pidsGoneAtMs = Date.now() - shutdownAt }
    if (endRowsSeen && allPidsGone) break
    await wait(40)
  }
} finally {
  await Promise.race([exit, wait(10_000)])
  if (!exited) { daemon.kill('SIGTERM'); await Promise.race([exit, wait(5_000)]) }
  if (!exited) { daemon.kill('SIGKILL'); await exit }
  await fixture.close()
}
if (failure) { console.error(output); throw failure }
assert.equal(allBornIds.length, 3, `three workers were born: ${JSON.stringify(allBornIds)}`)
assert.equal(workerPids.length, bornIds.length, `the roster must name a live pid for every worker still live before the shutdown: ${JSON.stringify(bornIds)} roster ${JSON.stringify(roster)}`)
assert.equal(pidsAliveBefore.length, bornIds.length, `every remaining worker must be a live process before the shutdown: pids ${JSON.stringify(workerPids)} alive ${JSON.stringify(pidsAliveBefore)}`)
assert.ok(endRowsSeen, `the daemon left before every worker's end row landed: births ${JSON.stringify(bornIds)} reaps ${JSON.stringify(reaps().map(r => r.id))} exits ${JSON.stringify(exits().map(r => r.id))}`)
const survivors = workerPids.filter(pidAlive)
assert.deepEqual(survivors, [], `worker process(es) still alive ${STOP_DEADLINE_MS}ms after the shutdown request: pids ${JSON.stringify(survivors)} of ${JSON.stringify(workerPids)}`)
assert.ok(allPidsGone && pidsGoneAtMs >= 0 && pidsGoneAtMs <= KILL_BOUND_MS, `the shutdown's own kill must end every worker within ${KILL_BOUND_MS}ms (the parent-death watch alone takes ~8s and stdin EOF waits for the daemon to leave); observed ${pidsGoneAtMs}ms`)
for (const [i, id] of bornIds.entries()) {
  const reaped = reaps().filter(r => r.id === bornShorts[i])
  assert.equal(reaped.length, 1, `worker ${id} has ${reaped.length} reap row(s); the daemon shutdown writes exactly one, synchronously, before it kills`)
  assert.equal(reaped[0]?.pid, workerPids[i], `reap row for ${id} names pid ${reaped[0]?.pid}, the birth row named ${workerPids[i]}`)
  assert.ok(String((reaped[0] as { reason?: string }).reason).startsWith('daemon-shutdown:'), `reap row for ${id} names no shutdown reason`)
  assert.ok(exits().filter(r => r.id === id).length <= 1, `worker ${id} wrote more than one exit row`)
}
console.log(`PASS every remaining fixture worker is reaped with its daemon (one reap row per worker naming its roster pid, read from the ledger before the daemon left; every worker pid observed gone ${pidsGoneAtMs}ms after the shutdown request (bound ${KILL_BOUND_MS}ms); ${exits().length} exit row(s) also observed)`)
rmSync(scratch, { recursive: true, force: true })
