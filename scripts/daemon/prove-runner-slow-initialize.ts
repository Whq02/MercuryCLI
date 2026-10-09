#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(tmpdir(), 'runner-slow-init-home-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_SESSION_HOME

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const wire = await import('../../src/runner/wire/methods.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const connectionModule = await import('../../src/daemon/runnerConnection.ts')
const { RunnerConnection } = connectionModule

const capabilities = { holds_asks: true, elevation: false, elicitation: false, partial_rows: false } as never

type Stand = {
  connection: InstanceType<typeof RunnerConnection>
  refusals: string[]
  logs: string[]
  toHost: PassThrough
  closeRunner(): void
}

function stand(answerAfterMs: number | null): Stand {
  const toRunner = new PassThrough()
  const toHost = new PassThrough()
  const refusals: string[] = []
  const logs: string[] = []
  const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () =>
    answerAfterMs === null
      ? new Promise(() => {})
      : new Promise(resolve => setTimeout(() => resolve({ protocol: 1, runner: { version: '0.0.0-slow', pid: process.pid }, session_id: null }), answerAfterMs)),
  )
  runner.onRequest('queue/add', () => ({ accepted: true }))
  const connection = new RunnerConnection({ input: toHost, output: toRunner }, capabilities, {
    onRow: () => {},
    onAsk: () => ({ answer: Promise.resolve({ outcome: 'deny' as const }), withdraw: () => {} }),
    onApplied: () => {},
    onProtocolError: error => refusals.push(error.message),
    log: line => logs.push(line),
  })
  return {
    connection,
    refusals,
    logs,
    toHost,
    closeRunner: () => {
      runner.close('the runner exited')
      toHost.end()
    },
  }
}

section('§0 the table: the handshake carries no fixed deadline (the owner: a slow box is the box, never a fault of the session)')
check('initialize has no table deadline', wire.deadlineOf('initialize') === null, String(wire.deadlineOf('initialize')))
check('the other host requests keep theirs (queue/add, session/claim)', wire.deadlineOf('queue/add') !== null && wire.deadlineOf('session/claim') !== null)
check('the slow-boot marks double from 10 s', connectionModule.slowBootMarkMs?.(0) === 10_000 && connectionModule.slowBootMarkMs?.(1) === 20_000 && connectionModule.slowBootMarkMs?.(2) === 40_000)

section('§1 a runner that answers initialize after 12 s (the box under load) is waited on and admitted — never killed, never counted as a crash')
{
  const slow = stand(12_000)
  const startedAt = Date.now()
  const delivery = slow.connection.deliver({ type: 'prompt', content: 'words sent while the runner boots', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a11' })
  const result = await slow.connection.initialized
  const bootMs = Date.now() - startedAt
  check(`the handshake lands with the runner's answer (${bootMs} ms, past the old 10 s silence)`, result !== null && bootMs >= 11_500, j({ result, bootMs }))
  check('no protocol refusal is raised against the slow runner (the base killed it here: "did not answer initialize within 10000 ms")', slow.refusals.length === 0, j(slow.refusals))
  check('the daemon log marks the slow boot at 10 s while waiting', slow.logs.some(line => /has not answered initialize after 10 s — waiting while it lives/.test(line)), j(slow.logs))
  check('words delivered during the boot land once the runner is up', (await delivery) === true)
  slow.connection.close('done')
  slow.closeRunner()
}

section('§2 a runner that leaves before answering is settled by its exit, at once — the exit is the mark, not a clock')
{
  const dead = stand(null)
  await sleep(200)
  const closedAt = Date.now()
  dead.closeRunner()
  const result = await dead.connection.initialized
  const settleMs = Date.now() - closedAt
  check(`the handshake settles null within a second of the wire closing (${settleMs} ms)`, result === null && settleMs < 1_000, j({ result, settleMs }))
  check('no protocol refusal — a dead runner is a crash for the roster, not a wire fault', dead.refusals.length === 0, j(dead.refusals))
  check('the log says the runner did not answer and why', dead.logs.some(line => /did not answer initialize/.test(line)), j(dead.logs))
  dead.connection.close('done')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-runner-slow-initialize: ALL LAWS HOLD' : `prove-runner-slow-initialize: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
