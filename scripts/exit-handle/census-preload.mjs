import { createHook } from 'node:async_hooks'
import { subscribe } from 'node:diagnostics_channel'
import { writeFileSync } from 'node:fs'
import { inspect } from 'node:util'

const OUT = process.env.EXIT_CENSUS_OUT
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

const live = new Map()
const stacks = new WeakMap()

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
    }
  }
}

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

process.on('exit', code => record('exit-event', code, OUT, { drainSeams, drainReport }))
const originalReallyExit = process.reallyExit
process.reallyExit = function censusReallyExit(code) {
  record('reallyExit', code, OUT, { drainSeams, drainReport })
  return originalReallyExit.call(process, code)
}
