#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { RunnerQuiescence, RetirementFence } from '../../src/daemon/runnerQuiescence.ts'

const token = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const ask = (action: 'prepare' | 'commit' | 'cancel', id = token) => ({ subtype: 'quiesce' as const, action, token: id })
let checks = 0
function check(name: string, condition: boolean): void {
  assert.ok(condition, name)
  checks++
  console.log(`PASS ${name}`)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

{
  let flushes = 0
  const runner = new RunnerQuiescence({ refusal: () => null, flush: async () => { flushes++ } })
  check('commit requires preparation', !(await runner.request(ask('commit'))).ok)
  check('invalid tokens cannot reserve the runner', !(await runner.request(ask('prepare', 'x'))).ok)
  check('prepare flushes without committing', (await runner.request(ask('prepare'))).ok && flushes === 1 && !runner.committed)
  check('another prepare cannot overwrite a live token', !(await runner.request(ask('prepare', other))).ok)
  check('another token cannot cancel the prepared token', !(await runner.request(ask('cancel', other))).ok)
  check('another token cannot commit', !(await runner.request(ask('commit', other))).ok)
  check('commit rechecks and flushes again', (await runner.request(ask('commit'))).ok && runner.committed && flushes === 2)
  check('new input is not accepted after committed retirement', !runner.invalidate())
  check('cancellation cannot reopen a committed runner', !(await runner.request(ask('cancel'))).ok)
  check('repeated commit is idempotent', (await runner.request(ask('commit'))).ok && flushes === 2)
}

for (const hold of ['active turn', 'queued input', 'workflow', 'task', 'service', 'debugger', 'browser', 'Eval kernel', 'attachment', 'schedule']) {
  let reason: string | null = hold
  let flushes = 0
  const runner = new RunnerQuiescence({ refusal: () => reason, flush: async () => { flushes++ } })
  check(`${hold} refuses before persistence or retirement`, !(await runner.request(ask('prepare'))).ok && flushes === 0 && !runner.committed)
  reason = null
  check(`${hold} release allows a new preparation`, (await runner.request(ask('prepare'))).ok)
  reason = hold
  check(`${hold} is checked again at commit`, !(await runner.request(ask('commit'))).ok && !runner.committed)
}

{
  const written = deferred<void>()
  const runner = new RunnerQuiescence({ refusal: () => null, flush: () => written.promise })
  const prepare = runner.request(ask('prepare'))
  check('new input invalidates an unfinished durable flush', runner.invalidate())
  written.resolve()
  check('a stale flush completion cannot prepare', !(await prepare).ok)
  check('invalidated preparation cannot commit', !(await runner.request(ask('commit'))).ok)
}

{
  let reason: string | null = null
  const runner = new RunnerQuiescence({ refusal: () => reason, flush: async () => { reason = 'new capability appeared during flush' } })
  check('capabilities are rechecked after a durable flush', !(await runner.request(ask('prepare'))).ok && !runner.committed)
}

{
  let failFlush = true
  const runner = new RunnerQuiescence({ refusal: () => null, flush: async () => { if (failFlush) throw new Error('fsync refused') } })
  const refused = await runner.request(ask('prepare'))
  check('persistence refusal is visible and never commits', !refused.ok && refused.reason.includes('fsync refused') && !runner.committed)
  failFlush = false
  check('a persistence refusal permits a fresh attempt', (await runner.request(ask('prepare'))).ok)
  failFlush = true
  check('commit persistence failure invalidates preparation', !(await runner.request(ask('commit'))).ok && !runner.committed)
}

{
  const events: string[] = []
  const exit = deferred<boolean>()
  const commitSeen = deferred<void>()
  const runner = new RunnerQuiescence({ refusal: () => null, flush: async () => { events.push('flush') } })
  const fence = new RetirementFence({
    request: async request => {
      events.push(request.action)
      const response = await runner.request(request)
      if (request.action === 'commit') commitSeen.resolve()
      return response
    },
    refusal: () => null,
    persistIntent: () => { events.push('intent') },
    clearIntent: () => { events.push('clear') },
    expectExit: expected => { events.push(`expected:${expected}`) },
    observeExit: () => exit.promise,
    persistParked: () => { events.push('parked') },
  })
  const parking = fence.retire(token)
  check('dispatch is fenced synchronously before runner preparation', fence.fenced)
  await commitSeen.promise
  let demandSettled = false
  const demand = fence.demand().then(result => { demandSettled = true; return result })
  await Promise.resolve()
  check('a commit acknowledgement does not release dispatch before exit', fence.fenced && !demandSettled && !events.includes('parked'))
  const intentAt = events.indexOf('intent')
  const expectedAt = events.indexOf('expected:true')
  const commitAt = events.indexOf('commit')
  check('durable intent and expected exit precede commit', intentAt >= 0 && expectedAt >= 0 && commitAt >= 0 && intentAt < commitAt && expectedAt < commitAt)
  exit.resolve(true)
  check('observed exit persists parked state before releasing dispatch', (await parking).outcome === 'parked' && events.at(-1) === 'parked' && !fence.fenced)
  check('demand sees that the same session needs re-admission', (await demand).outcome === 'parked')
}

{
  const flushed = deferred<void>()
  const runner = new RunnerQuiescence({ refusal: () => null, flush: () => flushed.promise })
  let intent = false
  const fence = new RetirementFence({
    request: request => runner.request(request),
    refusal: () => null,
    persistIntent: () => { intent = true },
    clearIntent: () => { intent = false },
    expectExit: () => {},
    observeExit: async () => { throw new Error('must not retire after demand') },
    persistParked: () => { throw new Error('must not park after demand') },
  })
  const parking = fence.retire(token)
  const demand = fence.demand()
  flushed.resolve()
  const result = await parking
  check('demand during preparation cancels before durable intent', result.outcome === 'refused' && !result.fenced && !intent && !runner.committed)
  check('demand waits for confirmed cancellation', (await demand).outcome === 'refused' && !fence.fenced)
}

{
  const runner = new RunnerQuiescence({ refusal: () => null, flush: async () => {} })
  let observed = false
  let published = false
  const fence = new RetirementFence({
    request: async request => {
      const answer = await runner.request(request)
      if (request.action === 'commit') throw new Error('commit reply lost')
      return answer
    },
    refusal: () => null,
    persistIntent: () => {},
    clearIntent: () => { throw new Error('a committed runner cannot be cancelled') },
    expectExit: () => {},
    observeExit: async () => observed,
    persistParked: () => { published = true },
  })
  const result = await fence.retire(token)
  check('lost commit reply leaves the live runner fenced', result.outcome === 'refused' && result.fenced && fence.fenced && !published)
  const uncertain = await fence.reconcileExit()
  check('exit timeout never authorizes an assumed park', uncertain.outcome === 'refused' && fence.fenced && !published)
  observed = true
  check('a later observed exit completes the same durable transaction', (await fence.reconcileExit()).outcome === 'parked' && published && !fence.fenced)
}

{
  const runner = new RunnerQuiescence({ refusal: () => null, flush: async () => {} })
  const events: string[] = []
  const fence = new RetirementFence({
    request: request => { events.push(request.action); return runner.request(request) },
    refusal: () => null,
    persistIntent: () => { throw new Error('record publication refused') },
    clearIntent: () => {},
    expectExit: expected => { events.push(String(expected)) },
    observeExit: async () => true,
    persistParked: () => { throw new Error('no durable intent exists') },
  })
  const result = await fence.retire(token)
  check('failed durable intent cancels rather than retiring', result.outcome === 'refused' && !result.fenced && !runner.committed && !events.includes('commit') && !events.includes('true'))
}

console.log(`${checks} quiescence checks passed`)
