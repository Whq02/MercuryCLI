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
let failure: unknown
try {
  await until(async () => (await daemonControlRpc({ op: 'ping' }, { timeoutMs: 500 })).ok)
  await wait(2_000)
  assert.equal(births().length, 0, `boot without demand spawned workers: ${JSON.stringify(births())}`)
  console.log('PASS boot without demand creates zero workers')
  for (let n = 1; n <= 3; n++) {
    const reply = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', bornBlank: true } as never, { timeoutMs: 20_000 }) as { ok: boolean; runnerId?: string; error?: string }
    assert.equal(reply.ok, true, JSON.stringify(reply))
    await wait(1_000)
    assert.equal(births().length, n, `demand ${n} created a speculative spare`)
    console.log(`PASS demand ${n} creates exactly its own worker`)
  }
  assert.equal(fixture.messageRequests().length, 0, 'admission alone makes no inference request')
} catch (error) { failure = error }
finally {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => {})
  await Promise.race([exit, wait(10_000)])
  if (!exited) { daemon.kill('SIGTERM'); await Promise.race([exit, wait(5_000)]) }
  if (!exited) { daemon.kill('SIGKILL'); await exit }
  await fixture.close()
}
if (failure) { console.error(output); throw failure }
for (const birth of births()) {
  assert.ok(rows().some(r => r.event === 'exit' && r.id === birth.id), `missing exit for ${birth.id}`)
}
console.log('PASS every fixture worker exits with its daemon')
rmSync(scratch, { recursive: true, force: true })
