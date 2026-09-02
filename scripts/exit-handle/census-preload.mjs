// scripts/exit-handle/census-preload.mjs — THE HANDLE CENSUS at the exit cliff
// (TASK-017 D3, the headless exit abort after a tool ran).
//
// Loaded ahead of the bundle (`node --import <this file> dist/mercury.mjs -p …`)
// so it wraps process.reallyExit BEFORE signal-exit does: the census then runs
// at the TRUE cliff — after every product-side drain, the last JS before the
// runtime's own teardown. It records every live libuv handle and request the
// process still owns, an async_hooks census of still-alive resources by type,
// and the creation stack of every resource class that can carry in-flight
// I/O (so a live entry names its owner). JSON to $EXIT_CENSUS_OUT.
// Fixture-only: never part of a production boot.
import { createHook } from 'node:async_hooks'
import { subscribe } from 'node:diagnostics_channel'
import { writeFileSync } from 'node:fs'
import { inspect } from 'node:util'

const OUT = process.env.EXIT_CENSUS_OUT
// The drain owner publishes on this channel before it drains and after — the
// census dumps at BOTH points, so the pin is a delta inside one run (the
// entries existed, then were drained by name), never an absence.
const DRAIN_CHANNEL = 'mercury:exit-cliff-drain'
let drainReport = null
let drainSeams = null
const SKIP = new Set(['PROMISE', 'TickObject', 'Microtask'])
const STACKED = new Set([
  'FSREQCALLBACK', 'FSREQPROMISE', 'FILEHANDLE', 'FILEHANDLECLOSEREQ',
  'Timeout', 'Immediate',
  'PROCESSWRAP', 'PIPEWRAP', 'TTYWRAP', 'TCPWRAP', 'TCPCONNECTWRAP', 'PIPECONNECTWRAP',
  'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'QUERYWRAP', 'DNSCHANNEL',
  'FSEVENTWRAP', 'STATWATCHER', 'SIGNALWRAP', 'ZLIB', 'WORKER', 'MESSAGEPORT',
  'HTTPCLIENTREQUEST', 'HTTPINCOMINGMESSAGE', 'TLSWRAP', 'WRITEWRAP', 'SHUTDOWNWRAP',
  'RANDOMBYTESREQUEST', 'HASHREQUEST', 'PBKDF2REQUEST', 'SCRYPTREQUEST',
])

const live = new Map() // asyncId -> { type, trigger, stack? }
const stacks = new WeakMap() // resource -> creation stack

function captureStack() {
  const prev = Error.stackTraceLimit
  Error.stackTraceLimit = 30
  const raw = new Error().stack ?? ''
  Error.stackTraceLimit = prev
  return raw
    .split('\n')
    .slice(1)
    .map(line => line.trim())
    .filter(
      line =>
        !line.includes('census-preload.mjs') &&
        !line.includes('node:internal/async_hooks') &&
        !line.startsWith('at emitInitNative') &&
        !line.startsWith('at emitInitScript'),
    )
}

createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    if (SKIP.has(type)) return
    const entry = { type, trigger: triggerAsyncId }
    if (STACKED.has(type)) {
      entry.stack = captureStack()
      if (resource && typeof resource === 'object') stacks.set(resource, entry.stack)
    }
    live.set(asyncId, entry)
  },
  destroy(asyncId) {
    live.delete(asyncId)
  },
}).enable()

function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function describeHandle(h) {
  const kind = h?.constructor?.name ?? typeof h
  const inner = h?._handle
  const d = { kind }
  d.ref = safe(() =>
    typeof h.hasRef === 'function'
      ? h.hasRef()
      : inner && typeof inner.hasRef === 'function'
        ? inner.hasRef()
        : undefined,
  )
  switch (kind) {
    case 'ChildProcess':
      Object.assign(d, {
        pid: h.pid,
        spawnfile: h.spawnfile,
        args: safe(() => (h.spawnargs ?? []).join(' ').slice(0, 200)),
        exitCode: h.exitCode,
        signalCode: h.signalCode,
        killed: h.killed,
        connected: h.connected,
      })
      break
    case 'Timeout':
      Object.assign(d, {
        ms: h._idleTimeout,
        repeat: h._repeat != null,
        cb: h._onTimeout?.name || '(anonymous)',
      })
      break
    case 'Immediate':
      d.cb = h._onImmediate?.name || '(anonymous)'
      break
    case 'Server':
      d.address = safe(() => h.address())
      break
    case 'Worker':
      d.threadId = h.threadId
      break
    default:
      Object.assign(d, {
        fd: safe(() => h.fd ?? inner?.fd),
        handleKind: inner?.constructor?.name,
        readable: h.readable,
        writable: h.writable,
        pending: h.pending,
        isTTY: h.isTTY,
        remote: safe(() => (h.remoteAddress ? `${h.remoteAddress}:${h.remotePort}` : undefined)),
        path: safe(() => h._pipeName ?? inner?.path ?? h.path),
        server: safe(() => Boolean(h.server)),
      })
  }
  const st = stacks.get(h) ?? (inner ? stacks.get(inner) : undefined)
  if (st) d.stack = st.slice(0, 12)
  return d
}

function describeRequest(r) {
  const kind = r?.constructor?.name ?? typeof r
  const d = {
    kind,
    oncomplete: safe(() => r.oncomplete?.name || (r.oncomplete ? '(anonymous)' : undefined)),
  }
  // A promise-backed request (FSReqPromise, FileHandleCloseReq) is a WEAK
  // wrap: it stays listed after settling until the next GC. Its promise's
  // state tells in-flight from already-landed — the census keys on it.
  const promise = safe(() => r.promise)
  if (promise && typeof promise.then === 'function') {
    d.pending = inspect(promise, { depth: 0 }).includes('<pending>')
  } else if (kind === 'FSReqCallback' || kind === 'GetAddrInfoReqWrap' || kind === 'WriteWrap') {
    d.pending = true
  }
  if (kind === 'GetAddrInfoReqWrap') Object.assign(d, { hostname: r.hostname, family: r.family })
  if (kind === 'WriteWrap' || kind === 'ShutdownWrap') d.handleKind = r.handle?.constructor?.name
  if (kind === 'FSReqCallback') {
    d.context = safe(() => (r.context ? Object.keys(r.context).slice(0, 8).join(',') : undefined))
  }
  const st = stacks.get(r)
  if (st) d.stack = st.slice(0, 12)
  return d
}

function census(where, code) {
  const byType = {}
  const withStacks = []
  for (const [id, e] of live) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
    if (e.stack) withStacks.push({ id, type: e.type, stack: e.stack.slice(0, 8) })
  }
  const info = {}
  for (const t of process.getActiveResourcesInfo()) info[t] = (info[t] ?? 0) + 1
  return {
    where,
    code,
    pid: process.pid,
    node: process.versions.node,
    platform: process.platform,
    at: new Date().toISOString(),
    activeResourcesInfo: info,
    handles: process._getActiveHandles().map(describeHandle),
    requests: process._getActiveRequests().map(describeRequest),
    asyncHooksLiveByType: byType,
    asyncHooksLiveWithStacks: withStacks.slice(0, 80),
    exitStack: captureStack().slice(0, 16),
  }
}

function record(where, code, path = OUT, extra = {}) {
  if (!path) return
  try {
    writeFileSync(path, JSON.stringify({ ...census(where, code), ...extra }, null, 1))
  } catch (err) {
    try {
      writeFileSync(path, JSON.stringify({ where, error: String(err) }))
    } catch {
      // The census must never be the reason an exit fails.
    }
  }
}

// The BEFORE dump: the drain owner's 'before' message lands the moment the
// drain is about to run (the same moment in the poison arm, where it skips).
subscribe(DRAIN_CHANNEL, message => {
  if (!message || typeof message !== 'object') return
  if (message.phase === 'before') {
    drainSeams = message.seams ?? null
    record('before-drain', undefined, OUT ? `${OUT}.before-drain.json` : undefined, {
      drainSeams,
      drainSkipped: message.skipped === true,
    })
  } else if (message.phase === 'after') {
    drainReport = message.report ?? null
  }
})

// process.exit → 'exit' event → reallyExit: the event record is a fallback
// for a loop that drains naturally (no reallyExit ever runs); the reallyExit
// record, written later, is the cliff itself and overwrites it.
process.on('exit', code => record('exit-event', code, OUT, { drainSeams, drainReport }))
const originalReallyExit = process.reallyExit
process.reallyExit = function censusReallyExit(code) {
  record('reallyExit', code, OUT, { drainSeams, drainReport })
  return originalReallyExit.call(process, code)
}
