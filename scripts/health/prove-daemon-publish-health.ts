#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-publish-health-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const EMPTY_DAEMON_DIR = join(SCRATCH, 'empty-daemon')
for (const dir of [HOME, DAEMON_DIR, EMPTY_DAEMON_DIR]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const daemonScript = `
;(globalThis).MACRO = { VERSION: '1.0.0' }
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enableConfigs } from ${JSON.stringify(pathToFileURL(join(REPO, 'src/platform/config/globalConfig.ts')).href)}
enableConfigs()
const server = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/daemon/control/controlServer.ts')).href)})
const sock = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/daemon/control/controlSocket.ts')).href)})
const publish = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/platform/substrate/durablePublish.ts')).href)})

const dir = process.env.MERCURY_DAEMON_DIR
writeFileSync(sock.controlKeyPath(), 'k\\n')
await sock.writeDaemonState({
  pid: process.pid,
  version: '1.0.0',
  origin: 'transient',
  startedAt: Date.now(),
  dir,
  controlSock: sock.controlSockPath(),
})
const handle = await server.startControlServer({
  controlKey: 'k',
  isReady: () => true,
  dir,
  startedAt: Date.now(),
  maxInflight: 1,
  roster: { liveCount: () => 0, totalCount: () => 0, getRespawnState: () => ({ degraded: false }) },
  breaker: { shouldSuppressFire: () => false },
})

process.env.MERCURY_FAULT_INJECT = 'rename@retried.json:eperm#1'
publish._resetFaultInjectionCountersForTests()
publish.durableAtomicPublishSync(join(dir, 'retried.json'), 'ok', { platform: 'win32' })
delete process.env.MERCURY_FAULT_INJECT
process.stdout.write('READY_RETRIED\\n')

await new Promise((resolve) => {
  process.stdin.once('data', () => resolve(undefined))
})

process.env.MERCURY_FAULT_INJECT = 'rename@exhausted.json:eperm'
publish._resetFaultInjectionCountersForTests()
try {
  publish.durableAtomicPublishSync(join(dir, 'exhausted.json'), 'x', { platform: 'win32' })
} catch {}
delete process.env.MERCURY_FAULT_INJECT
process.stdout.write('READY_EXHAUSTED\\n')

await new Promise((resolve) => {
  process.stdin.once('end', () => resolve(undefined))
  process.stdin.resume()
})
await handle.close()
`

const child = spawn(process.execPath, ['-e', daemonScript], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdoutBuf = ''
const waitLine = (needle: string, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (stdoutBuf.includes(needle)) return resolve()
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}; stdout=${stdoutBuf}`)), timeoutMs)
    const onData = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf8')
      if (stdoutBuf.includes(needle)) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
  })

let stderrBuf = ''
child.stderr?.on('data', chunk => {
  stderrBuf += chunk.toString('utf8')
})

try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { durabilityChecks } = await import('../../src/platform/health/sections/durability.ts')
  const publishCheck = durabilityChecks().find(c => c.id === 'publish-retry-budget')!

  await waitLine('READY_RETRIED')
  const res1 = await publishCheck.run()
  check(
    '/health publish-retry-budget reports daemon retriedSuccesses when window counters are 0',
    res1.status === 'info' && res1.evidence.includes('saved 1 publication(s)') && res1.evidence.includes('retried.json'),
    `got status=${res1.status} evidence=${JSON.stringify(res1.evidence)} (stderr=${stderrBuf.trim()}) — expose publishHealth on daemon status in src/daemon/control/controlServer.ts + protocol.ts and read it in src/platform/health/sections/durability.ts`,
  )

  child.stdin?.write('next\n')
  await waitLine('READY_EXHAUSTED')
  const res2 = await publishCheck.run()
  check(
    '/health publish-retry-budget reports daemon budgetExhausted when window counters are 0',
    res2.status === 'warn' && res2.evidence.includes('1 publication(s) exhausted') && res2.evidence.includes('exhausted.json'),
    `got status=${res2.status} evidence=${JSON.stringify(res2.evidence)} — expose publishHealth on daemon status in src/daemon/control/controlServer.ts + protocol.ts and read it in src/platform/health/sections/durability.ts`,
  )

  process.env.MERCURY_DAEMON_DIR = EMPTY_DAEMON_DIR
  const res3 = await publishCheck.run()
  check(
    '/health publish-retry-budget falls back cleanly to local counters when no daemon is running',
    res3.status === 'ok' && res3.evidence === 'no transient rename contention observed this session',
    `got status=${res3.status} evidence=${JSON.stringify(res3.evidence)}`,
  )
} finally {
  child.stdin?.end()
  child.kill('SIGKILL')
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-daemon-publish-health' : `\nFAIL prove-daemon-publish-health (${failures})`)
process.exit(failures === 0 ? 0 : 1)
