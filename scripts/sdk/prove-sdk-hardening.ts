import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, MercuryConnectionError, MercuryError, MercuryExitError, MercuryTimeoutError, MercuryWireError } from '../../sdk/src/index.ts'
import { fixtureOutcomeRow } from '../../sdk/src/testing.ts'
import { PYTHON } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-hardening-'))
const fixture = join(scratch, 'runner.mjs')
writeFileSync(fixture, `import { createInterface } from 'node:readline'
import { closeSync } from 'node:fs'
const scenario = process.argv[2]
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
let interrupted = 0
let queued = 0
let clock = 0
const outcome = ${JSON.stringify(fixtureOutcomeRow({ session_id: 'hardening', turn_id: 'late', turn: 1, answer: 'late' }))}
const emit = row => send({ jsonrpc: '2.0', method: 'row', params: { ...row, seq: ++clock } })
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') {
    if (scenario === 'silent') return
    reply({ protocol: 1, runner: { version: '1.0.0-beta.44', pid: process.pid }, session_id: 'hardening' })
    if (scenario === 'backpressure') { process.stdin.pause(); setInterval(() => {}, 1000) }
  } else if (message.method === 'queue/add') {
    queued++
    if (scenario === 'never') return
    const id = message.params.id
    setTimeout(() => {
      reply({ accepted: true })
      emit({ type: 'turn', state: 'started', turn_id: 'late', session_id: 'hardening', timestamp: 't', message_ids: [id] })
      emit(outcome)
      send({ jsonrpc: '2.0', method: 'fixture/settled', params: {} })
    }, 400)
  } else if (message.method === 'turn/interrupt') {
    interrupted++
    reply({ interrupted: true })
    send({ jsonrpc: '2.0', method: 'fixture/interrupted', params: {} })
  } else if (message.method === 'session/facts') {
    if (scenario === 'die') { process.stderr.write('fixture runner stopped\\n'); process.exit(7) }
    if (scenario === 'eof') { closeSync(1); setInterval(() => {}, 1000); return }
    if (scenario.startsWith('bad-')) {
      const broken = {
        'bad-cancel': { method: '$/cancel_request', params: null },
        'bad-applied': { method: 'session/applied', params: { request_id: 'wrong', verb: 'set_model' } },
        'bad-complete': { method: 'elicitation/complete', params: {} },
        'bad-row': { method: 'row', params: { type: 'outcome', schema: 1 } },
        'bad-id': { id: null, method: 'permission/request', params: {} },
      }
      send({ jsonrpc: '2.0', ...broken[scenario] })
      return
    }
    reply({ interrupted, queued })
  }
}).on('close', () => setTimeout(() => process.exit(0), scenario === 'closing' ? 400 : 0))
`)
const mercury = (scenario: string) => ['node', fixture, scenario]
const guard = setTimeout(() => { console.error('FAIL hardening proof timed out'); process.exit(1) }, 45000)
try {
  await assert.rejects(connect({ mercury: mercury('silent'), timeoutMs: 50 }), error => error instanceof MercuryTimeoutError && error.method === 'initialize' && error.timeoutMs === 50 && error.message.includes('increase the timeout'))
  console.log('PASS connect timeout is configurable and typed')
  for (const cancellation of ['timeout', 'signal'] as const) {
    for (const interruptOnAbort of [false, true]) {
      const session = await connect({ mercury: mercury('late') })
      const settled = new Promise<void>(resolve => session.on('notification', event => { if (event.method === 'fixture/settled') resolve() }))
      const interrupted = new Promise<void>(resolve => session.on('notification', event => { if (event.method === 'fixture/interrupted') resolve() }))
      try {
        const start = performance.now()
        await assert.rejects(session.prompt('delayed receipt', { ...(cancellation === 'timeout' ? { timeoutMs: 50 } : { signal: AbortSignal.timeout(50) }), interruptOnAbort }), error => cancellation === 'timeout' ? error instanceof MercuryTimeoutError : error instanceof MercuryError && error.message === 'prompt: cancelled')
        assert(performance.now() - start < 300, 'the prompt wait must end before the delayed queue receipt')
        await settled
        if (interruptOnAbort) await interrupted
        const facts = await session.request('session/facts', {}) as unknown as { interrupted: number; queued: number }
        assert.equal(facts.queued, 1)
        assert.equal(facts.interrupted, Number(interruptOnAbort), 'a late accepted receipt interrupts only when requested')
      } finally { await session.close() }
    }
  }
  console.log('PASS prompt timeout and cancellation cover queue acceptance; late receipts preserve optional interruption')
  for (const scenario of ['eof', 'die', 'bad-cancel', 'bad-applied', 'bad-complete', 'bad-row', 'bad-id']) {
    const session = await connect({ mercury: mercury(scenario) })
    try {
      const iterator = session[Symbol.asyncIterator]()
      const first = iterator.next()
      const second = iterator.next()
      const clear = (error: MercuryError) => { session.clearRows(); return error }
      session.on('error', clear)
      const results = await Promise.allSettled([session.facts(), first, second])
      for (const result of results) {
        assert.equal(result.status, 'rejected')
        if (result.status !== 'rejected') continue
        const expected = scenario === 'eof' ? MercuryConnectionError : scenario === 'die' ? MercuryExitError : MercuryWireError
        assert(result.reason instanceof expected, `${scenario}: ${result.reason}`)
        if (scenario === 'die') assert.equal(result.reason.exit?.code, 7)
        if (scenario === 'eof') assert.match(result.reason.message, /output closed.*reconnect/)
      }
      await session.exit
      console.log(`PASS ${scenario} settles requests and every row waiter`)
    } finally { await session.close() }
  }
  const closing = await connect({ mercury: mercury('closing') })
  const waiting = [closing[Symbol.asyncIterator]().next(), closing[Symbol.asyncIterator]().next()]
  const close = closing.close()
  await assert.rejects(closing.request('session/leave', {}, { deadlineMs: null }), MercuryConnectionError)
  assert.throws(() => closing.notifyCredentialsChanged(), MercuryConnectionError)
  await close
  assert((await Promise.all(waiting)).every(row => row.done))
  await assert.rejects(closing.prompt('closed'), MercuryConnectionError)
  console.log('PASS requests during close reject immediately and all iterators end normally')
  const py = spawnSync(PYTHON, [join(root, 'scripts/sdk/python-hardening.py'), fixture], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 30000 })
  process.stdout.write(py.stdout)
  process.stderr.write(py.stderr)
  assert.equal(py.status, 0, py.error?.message)
  assert(!/never retrieved|Task was destroyed|was never awaited/.test(py.stderr), py.stderr)
} finally { clearTimeout(guard); rmSync(scratch, { recursive: true, force: true }) }
