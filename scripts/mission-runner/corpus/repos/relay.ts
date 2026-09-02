// ============================================================================
//  corpus repo: relay — a small ESM event router (node --test).
//  Registry (the shared owner) · routes (disjoint lanes) · queue (redelivery
//  cap) · dispatcher (sync-throw capture) · middleware pipeline (positional,
//  the wide-migration surface). Base tree is ALL-GREEN.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const PACKAGE_JSON = `{
  "name": "relay",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`

// ── src/registry.js ─────────────────────────────────────────────────────────

const REGISTRY_BASE = `// Route-kind registry — the ONE place a kind becomes routable. KIND_ORDER is
// the maintained default chain order; every registered kind appears in it.
const KINDS = new Map()

export const KIND_ORDER = ['alpha', 'beta', 'gamma']

export function registerKind(kind, factory) {
  if (KINDS.has(kind)) throw new Error('duplicate kind: ' + kind)
  KINDS.set(kind, factory)
}

export function makeHandler(kind, options) {
  const factory = KINDS.get(kind)
  if (!factory) throw new Error('unknown kind: ' + kind)
  return factory(options ?? {})
}

export function knownKinds() {
  return [...KINDS.keys()].sort()
}

export function resetKinds() {
  KINDS.clear()
}
`

/** reference: audit + replay join the ordered chain. */
const REGISTRY_EXTENDED = REGISTRY_BASE.replace(
  `export const KIND_ORDER = ['alpha', 'beta', 'gamma']`,
  `export const KIND_ORDER = ['alpha', 'audit', 'beta', 'gamma', 'replay']`,
)

// ── src/routes/*.js ─────────────────────────────────────────────────────────

const ALPHA_BASE = `import { registerKind } from '../registry.js'

// alpha: pass events whose topic matches ANY configured prefix.
export function makeAlpha(options) {
  const prefixes = options.prefixes ?? []
  return {
    kind: 'alpha',
    accepts(event) {
      return prefixes.some(p => event.topic.startsWith(p))
    },
    handle(event) {
      return { ...event, route: 'alpha' }
    },
  }
}

registerKind('alpha', makeAlpha)
`

/** lane defect: the accepts predicate is inverted. */
const ALPHA_INVERTED = ALPHA_BASE.replace(
  '      return prefixes.some(p => event.topic.startsWith(p))',
  '      return !prefixes.some(p => event.topic.startsWith(p))',
)

const BETA_BASE = `import { registerKind } from '../registry.js'

// beta: enrich events with a stamp WITHOUT mutating the caller's payload.
export function makeBeta(options) {
  const stamp = options.stamp ?? 'beta'
  return {
    kind: 'beta',
    accepts() {
      return true
    },
    handle(event) {
      const payload = { ...event.payload, stamp }
      return { ...event, payload, route: 'beta' }
    },
  }
}

registerKind('beta', makeBeta)
`

/** lane defect: in-place payload mutation. */
const BETA_MUTATING = BETA_BASE.replace(
  `      const payload = { ...event.payload, stamp }
      return { ...event, payload, route: 'beta' }`,
  `      const payload = event.payload
      payload.stamp = stamp
      return { ...event, payload, route: 'beta' }`,
)

const GAMMA_BASE = `import { registerKind } from '../registry.js'

// gamma: buffer events, then drain by priority (high first), FIFO in a band.
export function makeGamma() {
  const buffer = []
  let seq = 0
  return {
    kind: 'gamma',
    accepts() {
      return true
    },
    handle(event) {
      seq += 1
      buffer.push({ event, seq })
      return null
    },
    drain() {
      const ordered = [...buffer].sort(
        (a, b) => b.event.priority - a.event.priority || a.seq - b.seq,
      )
      buffer.length = 0
      return ordered.map(x => x.event)
    },
  }
}

registerKind('gamma', makeGamma)
`

/** lane defect: ascending priority drain. */
const GAMMA_ASCENDING = GAMMA_BASE.replace(
  '        (a, b) => b.event.priority - a.event.priority || a.seq - b.seq,',
  '        (a, b) => a.event.priority - b.event.priority || a.seq - b.seq,',
)

/** reference: the audit route. */
const AUDIT_ROUTE = `import { registerKind } from '../registry.js'

// audit: record every event; never blocks, never transforms.
export function makeAudit() {
  const log = []
  return {
    kind: 'audit',
    log,
    accepts() {
      return true
    },
    handle(event) {
      log.push({ topic: event.topic, at: log.length })
      return null
    },
  }
}

registerKind('audit', makeAudit)
`

/** reference: the replay route. */
const REPLAY_ROUTE = `import { registerKind } from '../registry.js'

// replay: buffer everything; replay() re-emits the buffered events in order.
export function makeReplay() {
  const buffer = []
  return {
    kind: 'replay',
    accepts() {
      return true
    },
    handle(event) {
      buffer.push(event)
      return null
    },
    replay() {
      return [...buffer]
    },
  }
}

registerKind('replay', makeReplay)
`

// ── src/queue.js ────────────────────────────────────────────────────────────

const QUEUE_BASE = `// Redelivery queue for failed handler calls. Bounded: MAX_REDELIVER attempts
// per event, then the event lands in the dead-letter list.
export const MAX_REDELIVER = 3

export function createQueue() {
  return { pending: [], dead: [] }
}

export function enqueue(queue, entry, attempt) {
  if (attempt >= MAX_REDELIVER) {
    queue.dead.push(entry)
    return false
  }
  queue.pending.push({ entry, attempt })
  return true
}

export function drain(queue, deliver) {
  // Drain snapshots the pending list FIRST: redeliveries enqueued during
  // delivery belong to the NEXT drain pass, keeping ordering stable and the
  // pass finite.
  const batch = queue.pending
  queue.pending = []
  const results = []
  for (const { entry, attempt } of batch) {
    results.push(deliver(entry, attempt))
  }
  return results
}
`

/** defect: drain iterates the LIVE pending list — re-entrant enqueues
 *  extend the current pass (double delivery in one pass, unbounded growth). */
const QUEUE_LIVE_ITERATION = QUEUE_BASE.replace(
  `  // Drain snapshots the pending list FIRST: redeliveries enqueued during
  // delivery belong to the NEXT drain pass, keeping ordering stable and the
  // pass finite.
  const batch = queue.pending
  queue.pending = []
  const results = []
  for (const { entry, attempt } of batch) {
    results.push(deliver(entry, attempt))
  }
  return results`,
  `  const results = []
  for (const { entry, attempt } of queue.pending) {
    results.push(deliver(entry, attempt))
  }
  queue.pending = []
  return results`,
)

// ── src/dispatch.js ─────────────────────────────────────────────────────────

const DISPATCH_BASE = `import { makeHandler } from './registry.js'
import { createQueue, drain, enqueue } from './queue.js'

// The dispatcher: sync-throwing handlers are captured and redelivered through
// the queue (handleFailure) — one failure enqueues exactly one redelivery,
// and the MAX_REDELIVER cap applies before an event goes dead.
export function createDispatcher(kinds) {
  const dispatcher = {
    handlers: kinds.map(k => makeHandler(k.kind, k.options)),
    queue: createQueue(),
    delivered: [],
    dispatch(event) {
      for (const handler of dispatcher.handlers) {
        if (!handler.accepts(event)) continue
        deliverOnce(dispatcher, handler, event, 0)
      }
      return dispatcher.delivered.length
    },
    redeliver() {
      return drain(dispatcher.queue, (entry, attempt) =>
        deliverOnce(dispatcher, entry.handler, entry.event, attempt),
      )
    },
  }
  return dispatcher
}

function deliverOnce(dispatcher, handler, event, attempt) {
  try {
    const out = handler.handle(event)
    if (out !== null && out !== undefined) dispatcher.delivered.push(out)
    return { ok: true }
  } catch (error) {
    return handleFailure(dispatcher, handler, event, attempt, error)
  }
}

function handleFailure(dispatcher, handler, event, attempt, error) {
  const queued = enqueue(dispatcher.queue, { handler, event }, attempt + 1)
  return { ok: false, queued, message: String(error && error.message) }
}
`

// ──: typed RelayResult refactor (reference impls) ───────────────────────

const DISPATCH_TYPED = `import { makeHandler } from './registry.js'
import { createQueue, drain, enqueue } from './queue.js'

// The dispatcher over typed RelayResults: every handler returns
// { status: 'routed', event } | { status: 'buffered' }; failures become
// { status: 'failed', queued, message } through the queue exactly once.
export function createDispatcher(kinds) {
  const dispatcher = {
    handlers: kinds.map(k => makeHandler(k.kind, k.options)),
    queue: createQueue(),
    delivered: [],
    dispatch(event) {
      const results = []
      for (const handler of dispatcher.handlers) {
        if (!handler.accepts(event)) continue
        results.push(deliverOnce(dispatcher, handler, event, 0))
      }
      return results
    },
    redeliver() {
      return drain(dispatcher.queue, (entry, attempt) =>
        deliverOnce(dispatcher, entry.handler, entry.event, attempt),
      )
    },
  }
  return dispatcher
}

function deliverOnce(dispatcher, handler, event, attempt) {
  try {
    const result = handler.handle(event)
    if (result.status === 'routed') dispatcher.delivered.push(result.event)
    return result
  } catch (error) {
    return handleFailure(dispatcher, handler, event, attempt, error)
  }
}

function handleFailure(dispatcher, handler, event, attempt, error) {
  const queued = enqueue(dispatcher.queue, { handler, event }, attempt + 1)
  return { status: 'failed', queued, message: String(error && error.message) }
}
`

const ALPHA_TYPED = ALPHA_BASE.replace(
  `    handle(event) {
      return { ...event, route: 'alpha' }
    },`,
  `    handle(event) {
      return { status: 'routed', event: { ...event, route: 'alpha' } }
    },`,
)

const BETA_TYPED = BETA_BASE.replace(
  `    handle(event) {
      const payload = { ...event.payload, stamp }
      return { ...event, payload, route: 'beta' }
    },`,
  `    handle(event) {
      const payload = { ...event.payload, stamp }
      return { status: 'routed', event: { ...event, payload, route: 'beta' } }
    },`,
)

const GAMMA_TYPED = GAMMA_BASE.replace(
  `    handle(event) {
      seq += 1
      buffer.push({ event, seq })
      return null
    },`,
  `    handle(event) {
      seq += 1
      buffer.push({ event, seq })
      return { status: 'buffered' }
    },`,
)

// ── src/mw/*.js — positional middleware (the wide-migration surface) ────────

const MW_LOG = `// log middleware: append a trace marker (positional signature).
export const name = 'log'

export function apply(event, config) {
  const marker = (config && config.marker) ?? 'log'
  const trace = [...(event.trace ?? []), marker]
  return { ...event, trace }
}
`

const MW_AUTH = `// auth middleware: drop events lacking an actor (positional signature).
export const name = 'auth'

export function apply(event, config) {
  const required = (config && config.required) ?? true
  if (required && !event.actor) return null
  return event
}
`

const MW_TRACE = `// trace middleware: stamp a deterministic traceId (positional signature).
export const name = 'trace'

export function apply(event, config) {
  const prefix = (config && config.prefix) ?? 't'
  const traceId = prefix + ':' + (event.actor ?? 'anon') + ':' + event.topic
  return { ...event, traceId }
}
`

const MW_RETRYTAG = `// retryTag middleware: tag the attempt count (positional signature).
export const name = 'retryTag'

export function apply(event, config) {
  const attempt = (config && config.attempt) ?? 0
  return { ...event, attempt }
}
`

const MW_METRICS = `// metrics middleware: count events per topic into config.counts.
export const name = 'metrics'

export function apply(event, config) {
  const counts = (config && config.counts) ?? {}
  counts[event.topic] = (counts[event.topic] ?? 0) + 1
  return event
}
`

const MW_TAGGER = `// tagger middleware: add static tags (positional signature).
export const name = 'tagger'

export function apply(event, config) {
  const tags = (config && config.tags) ?? []
  return { ...event, tags: [...(event.tags ?? []), ...tags] }
}
`

const PIPELINE_BASE = `import * as authMw from './mw/auth.js'
import * as logMw from './mw/log.js'
import * as metricsMw from './mw/metrics.js'
import * as retryTagMw from './mw/retryTag.js'
import * as taggerMw from './mw/tagger.js'
import * as traceMw from './mw/trace.js'

export const MIDDLEWARE = [authMw, logMw, traceMw, retryTagMw, metricsMw, taggerMw]

// runPipeline: thread an event through middleware positionally; a null return
// drops the event.
export function runPipeline(event, configs) {
  let current = event
  for (const mw of MIDDLEWARE) {
    const config = (configs ?? {})[mw.name]
    current = mw.apply(current, config)
    if (current === null) return { dropped: true, by: mw.name }
  }
  return { dropped: false, event: current }
}
`

/** reference: ctx-object middleware across all six modules + pipeline. */
const MW_LOG_CTX = `// log middleware: append a trace marker (ctx signature).
export const name = 'log'

export function apply(ctx) {
  const marker = (ctx.config && ctx.config.marker) ?? 'log'
  const trace = [...(ctx.event.trace ?? []), marker]
  return { event: { ...ctx.event, trace } }
}
`

const MW_AUTH_CTX = `// auth middleware: drop events lacking an actor (ctx signature).
export const name = 'auth'

export function apply(ctx) {
  const required = (ctx.config && ctx.config.required) ?? true
  if (required && !ctx.event.actor) return { drop: 'missing actor' }
  return { event: ctx.event }
}
`

const MW_TRACE_CTX = `// trace middleware: stamp a deterministic traceId (ctx signature).
export const name = 'trace'

export function apply(ctx) {
  const prefix = (ctx.config && ctx.config.prefix) ?? 't'
  const traceId = prefix + ':' + (ctx.event.actor ?? 'anon') + ':' + ctx.event.topic
  return { event: { ...ctx.event, traceId } }
}
`

const MW_RETRYTAG_CTX = `// retryTag middleware: tag the attempt count (ctx signature).
export const name = 'retryTag'

export function apply(ctx) {
  const attempt = (ctx.config && ctx.config.attempt) ?? 0
  return { event: { ...ctx.event, attempt } }
}
`

const MW_METRICS_CTX = `// metrics middleware: count events per topic into config.counts.
export const name = 'metrics'

export function apply(ctx) {
  const counts = (ctx.config && ctx.config.counts) ?? {}
  counts[ctx.event.topic] = (counts[ctx.event.topic] ?? 0) + 1
  return { event: ctx.event }
}
`

const MW_TAGGER_CTX = `// tagger middleware: add static tags (ctx signature).
export const name = 'tagger'

export function apply(ctx) {
  const tags = (ctx.config && ctx.config.tags) ?? []
  return { event: { ...ctx.event, tags: [...(ctx.event.tags ?? []), ...tags] } }
}
`

const PIPELINE_CTX = `import * as authMw from './mw/auth.js'
import * as logMw from './mw/log.js'
import * as metricsMw from './mw/metrics.js'
import * as retryTagMw from './mw/retryTag.js'
import * as taggerMw from './mw/tagger.js'
import * as traceMw from './mw/trace.js'

export const MIDDLEWARE = [authMw, logMw, traceMw, retryTagMw, metricsMw, taggerMw]

// runPipeline: thread an event through ctx-object middleware; { drop: reason }
// stops the pipeline with the middleware's own reason.
export function runPipeline(event, configs) {
  let current = event
  for (const mw of MIDDLEWARE) {
    const config = (configs ?? {})[mw.name]
    const result = mw.apply({ event: current, config })
    if (result.drop) return { dropped: true, by: mw.name, reason: result.drop }
    current = result.event
  }
  return { dropped: false, event: current }
}
`

// ──: backpressure (reference + naive falsify) ───────────────────────────

const QUEUE_BACKPRESSURE = QUEUE_BASE.replace(
  `// Redelivery queue for failed handler calls. Bounded: MAX_REDELIVER attempts
// per event, then the event lands in the dead-letter list.
export const MAX_REDELIVER = 3`,
  `// Redelivery queue for failed handler calls. Bounded: MAX_REDELIVER attempts
// per event, then the event lands in the dead-letter list. Backpressure is
// HYSTERETIC: paused at HIGH_WATER pending, resumed only when a drain brings
// pending back under LOW_WATER.
export const MAX_REDELIVER = 3
export const HIGH_WATER = 4
export const LOW_WATER = 2

export function underPressure(queue) {
  if (queue.paused && queue.pending.length < LOW_WATER) queue.paused = false
  if (!queue.paused && queue.pending.length >= HIGH_WATER) queue.paused = true
  return queue.paused
}`,
).replace(
  `export function createQueue() {
  return { pending: [], dead: [] }
}`,
  `export function createQueue() {
  return { pending: [], dead: [], paused: false }
}`,
)

const DISPATCH_BACKPRESSURE = DISPATCH_BASE.replace(
  `import { createQueue, drain, enqueue } from './queue.js'`,
  `import { createQueue, drain, enqueue, underPressure } from './queue.js'`,
).replace(
  `    dispatch(event) {
      for (const handler of dispatcher.handlers) {
        if (!handler.accepts(event)) continue
        deliverOnce(dispatcher, handler, event, 0)
      }
      return dispatcher.delivered.length
    },`,
  `    dispatch(event) {
      if (underPressure(dispatcher.queue)) {
        return { accepted: false, reason: 'backpressure' }
      }
      for (const handler of dispatcher.handlers) {
        if (!handler.accepts(event)) continue
        deliverOnce(dispatcher, handler, event, 0)
      }
      return { accepted: true, delivered: dispatcher.delivered.length }
    },`,
)

/** falsify: non-hysteretic — checks HIGH only, resumes immediately. */
const QUEUE_BACKPRESSURE_NAIVE = QUEUE_BACKPRESSURE.replace(
  `export function underPressure(queue) {
  if (queue.paused && queue.pending.length < LOW_WATER) queue.paused = false
  if (!queue.paused && queue.pending.length >= HIGH_WATER) queue.paused = true
  return queue.paused
}`,
  `export function underPressure(queue) {
  return queue.pending.length >= HIGH_WATER
}`,
)

// ── base tests ──────────────────────────────────────────────────────────────

const TEST_REGISTRY = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_ORDER, knownKinds, makeHandler } from '../src/registry.js'
import '../src/routes/alpha.js'
import '../src/routes/beta.js'
import '../src/routes/gamma.js'

test('all core kinds are registered and ordered', () => {
  assert.deepEqual(knownKinds(), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(KIND_ORDER, ['alpha', 'beta', 'gamma'])
})

test('unknown kind refuses', () => {
  assert.throws(() => makeHandler('nope'))
})
`

const TEST_ALPHA = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAlpha } from '../src/routes/alpha.js'

test('alpha accepts matching prefixes only', () => {
  const alpha = makeAlpha({ prefixes: ['ord.', 'pay.'] })
  assert.equal(alpha.accepts({ topic: 'ord.created' }), true)
  assert.equal(alpha.accepts({ topic: 'pay.settled' }), true)
  assert.equal(alpha.accepts({ topic: 'user.login' }), false)
})

test('alpha stamps its route', () => {
  const alpha = makeAlpha({ prefixes: ['a.'] })
  assert.equal(alpha.handle({ topic: 'a.x' }).route, 'alpha')
})
`

const TEST_BETA = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBeta } from '../src/routes/beta.js'

test('beta stamps a copy, never the original payload', () => {
  const beta = makeBeta({ stamp: 's1' })
  const original = { topic: 't', payload: { keep: true } }
  const out = beta.handle(original)
  assert.equal(out.payload.stamp, 's1')
  assert.deepEqual(original.payload, { keep: true })
})
`

const TEST_GAMMA = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGamma } from '../src/routes/gamma.js'

test('gamma drains high priority first, FIFO within a band', () => {
  const gamma = makeGamma()
  gamma.handle({ topic: 'a', priority: 1 })
  gamma.handle({ topic: 'b', priority: 5 })
  gamma.handle({ topic: 'c', priority: 5 })
  gamma.handle({ topic: 'd', priority: 3 })
  const drained = gamma.drain().map(e => e.topic)
  assert.deepEqual(drained, ['b', 'c', 'd', 'a'])
})

test('drain empties the buffer', () => {
  const gamma = makeGamma()
  gamma.handle({ topic: 'a', priority: 1 })
  gamma.drain()
  assert.deepEqual(gamma.drain(), [])
})
`

const TEST_QUEUE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQueue, drain, enqueue, MAX_REDELIVER } from '../src/queue.js'

test('enqueue respects the redelivery cap', () => {
  const queue = createQueue()
  assert.equal(enqueue(queue, { id: 1 }, 1), true)
  assert.equal(enqueue(queue, { id: 2 }, MAX_REDELIVER), false)
  assert.equal(queue.pending.length, 1)
  assert.equal(queue.dead.length, 1)
})

test('drain delivers the current batch exactly once', () => {
  const queue = createQueue()
  enqueue(queue, { id: 1 }, 1)
  enqueue(queue, { id: 2 }, 2)
  const seen = []
  drain(queue, (entry, attempt) => seen.push([entry.id, attempt]))
  assert.deepEqual(seen, [[1, 1], [2, 2]])
  assert.equal(queue.pending.length, 0)
})

test('redeliveries enqueued during a drain belong to the NEXT pass', () => {
  const queue = createQueue()
  enqueue(queue, { id: 1 }, 1)
  const passOne = []
  drain(queue, (entry, attempt) => {
    passOne.push(entry.id)
    if (entry.id === 1) enqueue(queue, { id: 1 }, attempt + 1)
  })
  assert.deepEqual(passOne, [1])
  assert.equal(queue.pending.length, 1)
  const passTwo = []
  drain(queue, entry => passTwo.push(entry.id))
  assert.deepEqual(passTwo, [1])
})
`

const TEST_DISPATCH = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'
import { resetKinds, registerKind } from '../src/registry.js'
import { MAX_REDELIVER } from '../src/queue.js'

function freshKinds() {
  resetKinds()
  registerKind('ok', () => ({
    kind: 'ok',
    accepts() { return true },
    handle(event) { return { ...event, route: 'ok' } },
  }))
  registerKind('boom', () => {
    let calls = 0
    return {
      kind: 'boom',
      accepts() { return true },
      handle() {
        calls += 1
        throw new Error('boom #' + calls)
      },
    }
  })
}

test('sync throw enqueues exactly one redelivery', () => {
  freshKinds()
  const dispatcher = createDispatcher([{ kind: 'ok' }, { kind: 'boom' }])
  dispatcher.dispatch({ topic: 't', payload: {} })
  assert.equal(dispatcher.delivered.length, 1)
  assert.equal(dispatcher.queue.pending.length, 1)
})

test('redelivery cap sends the event dead, never loops', () => {
  freshKinds()
  const dispatcher = createDispatcher([{ kind: 'boom' }])
  dispatcher.dispatch({ topic: 't', payload: {} })
  for (let i = 0; i < MAX_REDELIVER + 2; i++) dispatcher.redeliver()
  assert.equal(dispatcher.queue.pending.length, 0)
  assert.equal(dispatcher.queue.dead.length, 1)
})
`

const TEST_PIPELINE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../src/pipeline.js'

test('pipeline threads an event through every middleware', () => {
  const counts = {}
  const result = runPipeline(
    { topic: 'ord.created', actor: 'ana' },
    { log: { marker: 'm1' }, metrics: { counts }, tagger: { tags: ['x'] } },
  )
  assert.equal(result.dropped, false)
  assert.deepEqual(result.event.trace, ['m1'])
  assert.equal(result.event.traceId, 't:ana:ord.created')
  assert.equal(result.event.attempt, 0)
  assert.deepEqual(result.event.tags, ['x'])
  assert.equal(counts['ord.created'], 1)
})

test('auth drops actor-less events', () => {
  const result = runPipeline({ topic: 'x' }, {})
  assert.equal(result.dropped, true)
  assert.equal(result.by, 'auth')
})
`

// ── branch tests (typed RelayResult — failing until the refactor) ───────

const TEST_DISPATCH_TYPED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'
import { resetKinds } from '../src/registry.js'
import { makeAlpha } from '../src/routes/alpha.js'
import { makeBeta } from '../src/routes/beta.js'
import { makeGamma } from '../src/routes/gamma.js'
import { registerKind } from '../src/registry.js'

function freshCoreKinds() {
  resetKinds()
  registerKind('alpha', makeAlpha)
  registerKind('beta', makeBeta)
  registerKind('gamma', makeGamma)
}

test('routes return typed RelayResults', () => {
  const alpha = makeAlpha({ prefixes: ['a.'] })
  const routed = alpha.handle({ topic: 'a.x' })
  assert.equal(routed.status, 'routed')
  assert.equal(routed.event.route, 'alpha')
  const beta = makeBeta({})
  assert.equal(beta.handle({ topic: 't', payload: {} }).status, 'routed')
  const gamma = makeGamma()
  assert.deepEqual(gamma.handle({ topic: 't', priority: 1 }), { status: 'buffered' })
})

test('dispatch returns the typed result list', () => {
  freshCoreKinds()
  const dispatcher = createDispatcher([
    { kind: 'alpha', options: { prefixes: ['ord.'] } },
    { kind: 'gamma' },
  ])
  const results = dispatcher.dispatch({ topic: 'ord.created', payload: {} })
  assert.deepEqual(results.map(r => r.status), ['routed', 'buffered'])
  assert.equal(dispatcher.delivered.length, 1)
})

test('failures surface as typed failed results with queue truth', () => {
  resetKinds()
  registerKind('boom', () => ({
    kind: 'boom',
    accepts() { return true },
    handle() {
      throw new Error('boom')
    },
  }))
  const dispatcher = createDispatcher([{ kind: 'boom' }])
  const results = dispatcher.dispatch({ topic: 't', payload: {} })
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'failed')
  assert.equal(results[0].queued, true)
  assert.equal(dispatcher.queue.pending.length, 1)
})
`

/** branch: the registry spec follows the extended chain (the base
 *  registry test would contradict the new KIND_ORDER law). */
const TEST_REGISTRY_EXTENDED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_ORDER, knownKinds, makeHandler } from '../src/registry.js'
import '../src/routes/alpha.js'
import '../src/routes/beta.js'
import '../src/routes/gamma.js'
import '../src/routes/audit.js'
import '../src/routes/replay.js'

test('all five kinds are registered and ordered', () => {
  assert.deepEqual(knownKinds(), ['alpha', 'audit', 'beta', 'gamma', 'replay'])
  assert.deepEqual(KIND_ORDER, ['alpha', 'audit', 'beta', 'gamma', 'replay'])
})

test('unknown kind refuses', () => {
  assert.throws(() => makeHandler('nope'))
})
`

const TEST_ALPHA_TYPED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAlpha } from '../src/routes/alpha.js'

test('alpha accepts matching prefixes only', () => {
  const alpha = makeAlpha({ prefixes: ['ord.', 'pay.'] })
  assert.equal(alpha.accepts({ topic: 'ord.created' }), true)
  assert.equal(alpha.accepts({ topic: 'user.login' }), false)
})

test('alpha returns a typed routed result', () => {
  const alpha = makeAlpha({ prefixes: ['a.'] })
  const result = alpha.handle({ topic: 'a.x' })
  assert.equal(result.status, 'routed')
  assert.equal(result.event.route, 'alpha')
})
`

const TEST_BETA_TYPED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBeta } from '../src/routes/beta.js'

test('beta stamps a copy inside a typed result, never the original payload', () => {
  const beta = makeBeta({ stamp: 's1' })
  const original = { topic: 't', payload: { keep: true } }
  const result = beta.handle(original)
  assert.equal(result.status, 'routed')
  assert.equal(result.event.payload.stamp, 's1')
  assert.deepEqual(original.payload, { keep: true })
})
`

const TEST_GAMMA_TYPED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGamma } from '../src/routes/gamma.js'

test('gamma buffers via the typed result', () => {
  const gamma = makeGamma()
  assert.deepEqual(gamma.handle({ topic: 'a', priority: 1 }), { status: 'buffered' })
})

test('gamma still drains high priority first, FIFO within a band', () => {
  const gamma = makeGamma()
  gamma.handle({ topic: 'a', priority: 1 })
  gamma.handle({ topic: 'b', priority: 5 })
  gamma.handle({ topic: 'c', priority: 5 })
  gamma.handle({ topic: 'd', priority: 3 })
  assert.deepEqual(gamma.drain().map(e => e.topic), ['b', 'c', 'd', 'a'])
})
`

// ── branch tests (audit + replay — failing until implemented) ───────────

const TEST_AUDIT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_ORDER, knownKinds, makeHandler } from '../src/registry.js'
import '../src/routes/alpha.js'
import '../src/routes/beta.js'
import '../src/routes/gamma.js'
import '../src/routes/audit.js'

test('audit joins the registry and the ordered chain', () => {
  assert.ok(knownKinds().includes('audit'))
  assert.deepEqual(KIND_ORDER, ['alpha', 'audit', 'beta', 'gamma', 'replay'])
})

test('audit records every event and never transforms', () => {
  const audit = makeHandler('audit')
  assert.equal(audit.accepts({ topic: 'any' }), true)
  assert.equal(audit.handle({ topic: 'one' }), null)
  assert.equal(audit.handle({ topic: 'two' }), null)
  assert.deepEqual(audit.log.map(row => row.topic), ['one', 'two'])
})
`

const TEST_REPLAY = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KIND_ORDER, knownKinds, makeHandler } from '../src/registry.js'
import '../src/routes/alpha.js'
import '../src/routes/beta.js'
import '../src/routes/gamma.js'
import '../src/routes/replay.js'

test('replay joins the registry and the ordered chain', () => {
  assert.ok(knownKinds().includes('replay'))
  assert.deepEqual(KIND_ORDER, ['alpha', 'audit', 'beta', 'gamma', 'replay'])
})

test('replay buffers and re-emits in order', () => {
  const replay = makeHandler('replay')
  replay.handle({ topic: 'one' })
  replay.handle({ topic: 'two' })
  assert.deepEqual(replay.replay().map(e => e.topic), ['one', 'two'])
  assert.deepEqual(replay.replay().map(e => e.topic), ['one', 'two'])
})
`

// ── branch tests (ctx middleware — failing until migrated) ──────────────

const TEST_MW_CTX = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as authMw from '../src/mw/auth.js'
import * as logMw from '../src/mw/log.js'
import * as metricsMw from '../src/mw/metrics.js'
import * as retryTagMw from '../src/mw/retryTag.js'
import * as taggerMw from '../src/mw/tagger.js'
import * as traceMw from '../src/mw/trace.js'

test('log rides the ctx signature', () => {
  const out = logMw.apply({ event: { topic: 't' }, config: { marker: 'm' } })
  assert.deepEqual(out.event.trace, ['m'])
})

test('auth drops via a typed drop reason', () => {
  const out = authMw.apply({ event: { topic: 't' }, config: {} })
  assert.equal(out.drop, 'missing actor')
  const pass = authMw.apply({ event: { topic: 't', actor: 'a' }, config: {} })
  assert.equal(pass.event.actor, 'a')
})

test('trace rides the ctx signature', () => {
  const out = traceMw.apply({ event: { topic: 'x', actor: 'b' }, config: { prefix: 'p' } })
  assert.equal(out.event.traceId, 'p:b:x')
})

test('retryTag rides the ctx signature', () => {
  const out = retryTagMw.apply({ event: { topic: 'x' }, config: { attempt: 2 } })
  assert.equal(out.event.attempt, 2)
})

test('metrics counts through ctx config', () => {
  const counts = {}
  metricsMw.apply({ event: { topic: 'x' }, config: { counts } })
  metricsMw.apply({ event: { topic: 'x' }, config: { counts } })
  assert.equal(counts.x, 2)
})

test('tagger rides the ctx signature', () => {
  const out = taggerMw.apply({ event: { topic: 'x', tags: ['a'] }, config: { tags: ['b'] } })
  assert.deepEqual(out.event.tags, ['a', 'b'])
})
`

const TEST_PIPELINE_CTX = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline } from '../src/pipeline.js'

test('pipeline threads ctx middleware and keeps behavior', () => {
  const counts = {}
  const result = runPipeline(
    { topic: 'ord.created', actor: 'ana' },
    { log: { marker: 'm1' }, metrics: { counts }, tagger: { tags: ['x'] } },
  )
  assert.equal(result.dropped, false)
  assert.deepEqual(result.event.trace, ['m1'])
  assert.equal(result.event.traceId, 't:ana:ord.created')
  assert.equal(counts['ord.created'], 1)
})

test('pipeline surfaces the typed drop reason', () => {
  const result = runPipeline({ topic: 'x' }, {})
  assert.equal(result.dropped, true)
  assert.equal(result.by, 'auth')
  assert.equal(result.reason, 'missing actor')
})
`

// ── branch test (integration — fails on the live-iteration defect) ──────

const TEST_REDELIVERY_INTEGRATION = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'
import { registerKind, resetKinds } from '../src/registry.js'

// One handler that fails twice, then succeeds. Every redelivery pass must
// deliver each pending entry EXACTLY once; a second failure belongs to the
// NEXT pass.
test('redelivery passes are finite and exactly-once per pass', () => {
  resetKinds()
  let calls = 0
  registerKind('flaky', () => ({
    kind: 'flaky',
    accepts() { return true },
    handle(event) {
      calls += 1
      if (calls <= 2) throw new Error('not yet (call ' + calls + ')')
      return { ...event, route: 'flaky' }
    },
  }))
  const dispatcher = createDispatcher([{ kind: 'flaky' }])
  dispatcher.dispatch({ topic: 't', payload: {} })
  assert.equal(calls, 1)
  const passOne = dispatcher.redeliver()
  assert.equal(passOne.length, 1, 'pass one delivered its single entry once, saw ' + passOne.length)
  assert.equal(calls, 2)
  const passTwo = dispatcher.redeliver()
  assert.equal(passTwo.length, 1)
  assert.equal(calls, 3)
  assert.equal(dispatcher.delivered.length, 1)
  assert.equal(dispatcher.queue.pending.length, 0)
})
`

// ── branch tests (backpressure — failing until implemented) ─────────────

const TEST_BACKPRESSURE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'
import { registerKind, resetKinds } from '../src/registry.js'
import { HIGH_WATER, LOW_WATER } from '../src/queue.js'

function boomDispatcher() {
  resetKinds()
  registerKind('boom', () => ({
    kind: 'boom',
    accepts() { return true },
    handle() {
      throw new Error('boom')
    },
  }))
  return createDispatcher([{ kind: 'boom' }])
}

test('watermarks are configured sanely', () => {
  assert.ok(LOW_WATER < HIGH_WATER)
})

test('dispatch reports acceptance as a typed record', () => {
  const dispatcher = boomDispatcher()
  const result = dispatcher.dispatch({ topic: 't1', payload: {} })
  assert.equal(result.accepted, true)
})

test('dispatch pauses at the high watermark', () => {
  const dispatcher = boomDispatcher()
  for (let i = 0; i < HIGH_WATER; i++) {
    dispatcher.dispatch({ topic: 't' + i, payload: {} })
  }
  const refused = dispatcher.dispatch({ topic: 'over', payload: {} })
  assert.equal(refused.accepted, false)
  assert.equal(refused.reason, 'backpressure')
})

test('pressure holds until pending falls under the LOW watermark', () => {
  const dispatcher = boomDispatcher()
  for (let i = 0; i < HIGH_WATER; i++) {
    dispatcher.dispatch({ topic: 't' + i, payload: {} })
  }
  assert.equal(dispatcher.dispatch({ topic: 'x', payload: {} }).accepted, false)
  // One redelivery pass: every entry fails again and re-enqueues, so pending
  // stays AT the high count — still paused (hysteresis, not a threshold read).
  dispatcher.redeliver()
  assert.equal(dispatcher.queue.pending.length, HIGH_WATER)
  assert.equal(dispatcher.dispatch({ topic: 'y', payload: {} }).accepted, false)
  // Drop the queue below LOW_WATER by force, as an operator drain would.
  dispatcher.queue.pending.length = LOW_WATER - 1
  assert.equal(dispatcher.dispatch({ topic: 'z', payload: {} }).accepted, true)
})

test('pressure does NOT resume between LOW and HIGH (the hysteresis band)', () => {
  const dispatcher = boomDispatcher()
  for (let i = 0; i < HIGH_WATER; i++) {
    dispatcher.dispatch({ topic: 't' + i, payload: {} })
  }
  assert.equal(dispatcher.dispatch({ topic: 'x', payload: {} }).accepted, false)
  // Between the watermarks: still paused.
  dispatcher.queue.pending.length = LOW_WATER
  assert.equal(dispatcher.dispatch({ topic: 'mid', payload: {} }).accepted, false)
})
`

// ── comparison-partition overlays (task/cmp-*) ────────────────────

/** reference: dead-letter introspection at the queue + dispatcher owners. */
const QUEUE_DEADLETTER = QUEUE_BASE + `
// deadLetters: typed rows for events that exhausted their redeliveries.
export function deadLetters(queue) {
  return queue.dead.map(entry => ({ entry, reason: 'cap' }))
}
`

const DISPATCH_DEADLETTER = DISPATCH_BASE.replace(
  `import { createQueue, drain, enqueue } from './queue.js'`,
  `import { createQueue, deadLetters, drain, enqueue } from './queue.js'`,
).replace(
  `    redeliver() {
      return drain(dispatcher.queue, (entry, attempt) =>
        deliverOnce(dispatcher, entry.handler, entry.event, attempt),
      )
    },`,
  `    redeliver() {
      return drain(dispatcher.queue, (entry, attempt) =>
        deliverOnce(dispatcher, entry.handler, entry.event, attempt),
      )
    },
    dead() {
      return deadLetters(dispatcher.queue).map(row => row.entry.event.topic)
    },`,
)

/** branch: the dead-letter acceptance oracle (failing until built). */
const TEST_DEADLETTER = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'
import { registerKind, resetKinds } from '../src/registry.js'
import { createQueue, deadLetters, enqueue, MAX_REDELIVER } from '../src/queue.js'

test('deadLetters reports typed rows with the cap reason', () => {
  const queue = createQueue()
  enqueue(queue, { id: 1 }, MAX_REDELIVER)
  const rows = deadLetters(queue)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, 'cap')
  assert.deepEqual(rows[0].entry, { id: 1 })
})

test('an empty dead list reports no rows', () => {
  assert.deepEqual(deadLetters(createQueue()), [])
})

test('dispatcher.dead() names the dead event topics', () => {
  resetKinds()
  registerKind('boom', () => ({
    kind: 'boom',
    accepts() { return true },
    handle() {
      throw new Error('boom')
    },
  }))
  const dispatcher = createDispatcher([{ kind: 'boom' }])
  dispatcher.dispatch({ topic: 'doomed', payload: {} })
  for (let i = 0; i < MAX_REDELIVER + 2; i++) dispatcher.redeliver()
  assert.deepEqual(dispatcher.dead(), ['doomed'])
})
`

/** review state: a committed 'hardening' change that quietly widened
 *  prefix matching into substring matching. Base tests stay green. */
const ALPHA_INCLUDES_GUARD = ALPHA_BASE.replace(
  `    accepts(event) {
      return prefixes.some(p => event.topic.startsWith(p))
    },`,
  `    accepts(event) {
      if (!event.topic) return false
      return prefixes.some(p => event.topic.includes(p))
    },`,
)

/** defect: gamma drains LIFO within a priority band. */
const GAMMA_LIFO_BAND = GAMMA_BASE.replace(
  '        (a, b) => b.event.priority - a.event.priority || a.seq - b.seq,',
  '        (a, b) => b.event.priority - a.event.priority || b.seq - a.seq,',
)

/** reference: drain -> drainQueue at the queue owner; the dispatcher
 *  follows; gamma's own drain() method is the DECOY and stays. */
const QUEUE_RENAMED_DRAIN = QUEUE_BASE.replace(
  `export function drain(queue, deliver) {`,
  `export function drainQueue(queue, deliver) {`,
)

const DISPATCH_RENAMED_DRAIN = DISPATCH_BASE.replace(
  `import { createQueue, drain, enqueue } from './queue.js'`,
  `import { createQueue, drainQueue, enqueue } from './queue.js'`,
).replace(
  `      return drain(dispatcher.queue, (entry, attempt) =>`,
  `      return drainQueue(dispatcher.queue, (entry, attempt) =>`,
)

/** falsify: the decoy rename — gamma.drain renamed too. */
const GAMMA_DRAIN_RENAMED = GAMMA_BASE.replace(
  `    drain() {`,
  `    drainQueue() {`,
)

/** branch: the rename spec (failing until queue + dispatcher move). */
const TEST_QUEUE_RENAMED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as queueModule from '../src/queue.js'
import { createQueue, drainQueue, enqueue, MAX_REDELIVER } from '../src/queue.js'
import { makeGamma } from '../src/routes/gamma.js'

test('the queue drainer is named drainQueue now', () => {
  assert.equal(typeof drainQueue, 'function')
  assert.ok(!('drain' in queueModule), 'the old queue.drain name must be gone')
})

test('gamma keeps its OWN drain method (unrelated buffer drain)', () => {
  const gamma = makeGamma()
  assert.equal(typeof gamma.drain, 'function')
})

test('enqueue respects the redelivery cap', () => {
  const queue = createQueue()
  assert.equal(enqueue(queue, { id: 1 }, 1), true)
  assert.equal(enqueue(queue, { id: 2 }, MAX_REDELIVER), false)
  assert.equal(queue.pending.length, 1)
  assert.equal(queue.dead.length, 1)
})

test('drainQueue delivers the current batch exactly once', () => {
  const queue = createQueue()
  enqueue(queue, { id: 1 }, 1)
  enqueue(queue, { id: 2 }, 2)
  const seen = []
  drainQueue(queue, (entry, attempt) => seen.push([entry.id, attempt]))
  assert.deepEqual(seen, [[1, 1], [2, 2]])
  assert.equal(queue.pending.length, 0)
})

test('redeliveries enqueued during a drain belong to the NEXT pass', () => {
  const queue = createQueue()
  enqueue(queue, { id: 1 }, 1)
  const passOne = []
  drainQueue(queue, (entry, attempt) => {
    passOne.push(entry.id)
    if (entry.id === 1) enqueue(queue, { id: 1 }, attempt + 1)
  })
  assert.deepEqual(passOne, [1])
  assert.equal(queue.pending.length, 1)
})
`

const BASE_FILES: FileMap = {
  'package.json': PACKAGE_JSON,
  'src/registry.js': REGISTRY_BASE,
  'src/routes/alpha.js': ALPHA_BASE,
  'src/routes/beta.js': BETA_BASE,
  'src/routes/gamma.js': GAMMA_BASE,
  'src/queue.js': QUEUE_BASE,
  'src/dispatch.js': DISPATCH_BASE,
  'src/mw/log.js': MW_LOG,
  'src/mw/auth.js': MW_AUTH,
  'src/mw/trace.js': MW_TRACE,
  'src/mw/retryTag.js': MW_RETRYTAG,
  'src/mw/metrics.js': MW_METRICS,
  'src/mw/tagger.js': MW_TAGGER,
  'src/pipeline.js': PIPELINE_BASE,
  'test/registry.test.mjs': TEST_REGISTRY,
  'test/alpha.test.mjs': TEST_ALPHA,
  'test/beta.test.mjs': TEST_BETA,
  'test/gamma.test.mjs': TEST_GAMMA,
  'test/queue.test.mjs': TEST_QUEUE,
  'test/dispatch.test.mjs': TEST_DISPATCH,
  'test/pipeline.test.mjs': TEST_PIPELINE,
}

const BRANCHES: Record<string, BranchOverlay> = {
  'task/refactor-ack': {
    'test/dispatch.test.mjs': TEST_DISPATCH_TYPED,
    'test/alpha.test.mjs': TEST_ALPHA_TYPED,
    'test/beta.test.mjs': TEST_BETA_TYPED,
    'test/gamma.test.mjs': TEST_GAMMA_TYPED,
  },
  'task/queue-race': {
    'src/queue.js': QUEUE_LIVE_ITERATION,
    'test/redelivery.test.mjs': TEST_REDELIVERY_INTEGRATION,
  },
  'task/three-lanes': {
    'src/routes/alpha.js': ALPHA_INVERTED,
    'src/routes/beta.js': BETA_MUTATING,
    'src/routes/gamma.js': GAMMA_ASCENDING,
  },
  'task/shared-registry': {
    'test/audit.test.mjs': TEST_AUDIT,
    'test/replay.test.mjs': TEST_REPLAY,
    'test/registry.test.mjs': TEST_REGISTRY_EXTENDED,
  },
  'task/wide-migration': {
    'test/mw.test.mjs': TEST_MW_CTX,
    'test/pipeline.test.mjs': TEST_PIPELINE_CTX,
  },
  'task/coupled-backpressure': { 'test/backpressure.test.mjs': TEST_BACKPRESSURE },
  'task/cmp-deadletter': { 'test/deadletter.test.mjs': TEST_DEADLETTER },
  'task/cmp-review': { 'src/routes/alpha.js': ALPHA_INCLUDES_GUARD },
  'task/cmp-gamma-fifo': { 'src/routes/gamma.js': GAMMA_LIFO_BAND },
  'task/cmp-rename-drain': { 'test/queue.test.mjs': TEST_QUEUE_RENAMED },
}

export const RELAY_REPO: HelixRepoSpec = {
  id: 'relay',
  seed: 'inline',
  files: BASE_FILES,
  branches: BRANCHES,
}

export const RELAY_CONTENT = {
  ALPHA_BASE,
  BETA_BASE,
  GAMMA_BASE,
  QUEUE_BASE,
  DISPATCH_BASE,
  DISPATCH_TYPED,
  ALPHA_TYPED,
  BETA_TYPED,
  GAMMA_TYPED,
  REGISTRY_EXTENDED,
  AUDIT_ROUTE,
  REPLAY_ROUTE,
  MW_LOG_CTX,
  MW_AUTH_CTX,
  MW_TRACE_CTX,
  MW_RETRYTAG_CTX,
  MW_METRICS_CTX,
  MW_TAGGER_CTX,
  PIPELINE_CTX,
  QUEUE_BACKPRESSURE,
  DISPATCH_BACKPRESSURE,
  QUEUE_BACKPRESSURE_NAIVE,
  TEST_DISPATCH,
  TEST_QUEUE,
  QUEUE_DEADLETTER,
  DISPATCH_DEADLETTER,
  QUEUE_RENAMED_DRAIN,
  DISPATCH_RENAMED_DRAIN,
  GAMMA_DRAIN_RENAMED,
} as const
