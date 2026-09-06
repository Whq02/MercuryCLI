#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_API_TIMEOUT_MS = '2500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — watchdog pool-reset prover exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const { buildApiAgentOptions } = await import('../../src/utils/proxy.ts')

console.log('============================================================')
console.log(' watchdog pool reset — the poisoned-pool mechanism + wiring')
console.log('============================================================')

section('P1 — the mechanism under node: a pooled retry parks, a fresh agent recovers')
{
  const options = buildApiAgentOptions()
  check(
    'the real agent options keep sockets alive between requests (reuse is the default) with the fixture headers budget',
    options.keepAliveTimeout >= 5_000 && options.pipelining === 1 && options.headersTimeout === 2_500,
    JSON.stringify({ keepAliveTimeout: options.keepAliveTimeout, pipelining: options.pipelining, headersTimeout: options.headersTimeout }),
  )

  const undiciPath = join(ROOT, 'node_modules', 'undici', 'index.js')
  const driver = `
import { createServer } from 'node:http'
import { Agent, fetch as undiciFetch } from ${JSON.stringify(undiciPath)}

const agentOptions = JSON.parse(process.argv[2])
const perSocketCount = new WeakMap()
let socketsSeen = 0
let parkedRequests = 0
const server = createServer((req, res) => {
  const n = (perSocketCount.get(req.socket) ?? 0) + 1
  if (n === 1) socketsSeen++
  perSocketCount.set(req.socket, n)
  req.resume()
  req.on('end', () => {
    if (n >= 2) {
      parkedRequests++
      return // the half-dead keep-alive: nothing ever comes back
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})
server.requestTimeout = 0
server.headersTimeout = 0
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port
const post = (dispatcher, n) =>
  undiciFetch(base + '/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ probe: n }),
    headers: { 'content-type': 'application/json' },
    dispatcher,
  })
const verdict = {}
const poolA = new Agent(agentOptions)
const first = await post(poolA, 1)
verdict.firstOk = first.status === 200 && (await first.json()).ok === true
// Socket release is asynchronous after body consumption — the settle makes
// reuse deterministic (an immediate follow-up can race the release and open
// a second connection instead).
await new Promise(r => setTimeout(r, 150))
try {
  await post(poolA, 2)
  verdict.secondServed = true
} catch (e) {
  verdict.secondServed = false
  verdict.parkErrorName = e.name
  verdict.parkErrorCause = e.cause?.message ?? e.message
}
verdict.parkedRequests = parkedRequests
verdict.socketsSeenAfterPark = socketsSeen
const poolB = new Agent(agentOptions)
const t1 = Date.now()
const third = await post(poolB, 3)
verdict.recoveredOk = third.status === 200 && (await third.json()).ok === true
verdict.recoveredInMs = Date.now() - t1
verdict.socketsSeenAfterRecovery = socketsSeen
await poolA.destroy()
await poolB.destroy()
server.closeAllConnections?.()
server.close()
console.log('VERDICT ' + JSON.stringify(verdict))
`
  const driverDir = mkdtempSync(join(tmpdir(), 'pool-reset-driver-'))
  const driverPath = join(driverDir, 'driver.mjs')
  writeFileSync(driverPath, driver)
  const run = spawnSync('node', [driverPath, JSON.stringify(options)], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const verdictLine = (run.stdout ?? '').split('\n').find(l => l.startsWith('VERDICT '))
  const verdict = verdictLine
    ? (JSON.parse(verdictLine.slice('VERDICT '.length)) as Record<string, unknown>)
    : undefined
  check('the node driver ran to a verdict', verdict !== undefined, `status=${run.status} stderr=${(run.stderr ?? '').slice(0, 300)}`)
  if (verdict) {
    check('request 1 served on a fresh socket', verdict.firstOk === true)
    check(
      'request 2 RODE THE POOLED SOCKET and parked until the headers budget killed it',
      verdict.secondServed === false && verdict.parkedRequests === 1 && verdict.socketsSeenAfterPark === 1,
      JSON.stringify(verdict),
    )
    check(
      'the park died as the transport timeout (the operator-visible hang, bounded only by budgets)',
      String(verdict.parkErrorCause ?? verdict.parkErrorName ?? '').toLowerCase().includes('timeout'),
      String(verdict.parkErrorCause),
    )
    check(
      'a FRESH pool recovers instantly on a NEW socket',
      verdict.recoveredOk === true && verdict.socketsSeenAfterRecovery === 2 && Number(verdict.recoveredInMs) < 1_500,
      JSON.stringify(verdict),
    )
  }
}

section('P2 — the wiring: both watchdog recovery rungs drop the pool first')
{
  const proxySource = readFileSync(join(ROOT, 'src/utils/proxy.ts'), 'utf8')
  check(
    'resetApiConnectionPool exists and is NON-STICKY (drops the dispatcher, never touches keepAliveDisabled)',
    /export function resetApiConnectionPool\(\): void \{\s*apiDispatcher = null\s*\}/.test(proxySource),
  )
  const streamSource = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check(
    'the pre-first-event reissue drops the pool before continuing the streaming pass',
    /preFirstEventStreamRetryUsed = true[\s\S]{0,900}?resetApiConnectionPool\(\)[\s\S]{0,2400}?continue streamingPass/.test(streamSource),
  )
  check(
    'the non-streaming fallback drops the pool when the watchdog aborted the stream',
    /if \(streamIdleAborted\) resetApiConnectionPool\(\)/.test(streamSource),
  )
  check(
    'every streaming pass builds a FRESH client (the dropped pool actually re-reads on reissue)',
    /streamingPass: for \(;;\) \{[\s\S]{0,600}?getAnthropicClient\(\{/.test(streamSource),
  )
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
