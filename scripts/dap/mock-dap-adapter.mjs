#!/usr/bin/env node
// ============================================================================
//  mock-dap-adapter.mjs — a deterministic Debug Adapter Protocol responder
//  over stdio, for scripts/dap/prove-dap.ts. Implements exactly the requests
//  the Mercury DAP client issues, with fixed fixtures: thread 1/MainThread,
//  frames main(demo.py:3)+caller(demo.py:9), Locals ref 100 holding x=41,
//  evaluate('x+1') = 42. Stops on breakpoint after launch when breakpoints
//  were set; 'continue' terminates the debuggee. No dependencies.
//
//  Knobs (env): MOCK_DAP_TERMINATE_CAP=1 advertises supportTerminateDebuggee
//  (the default surface does not) · MOCK_DAP_TRACE=<file> appends one JSON
//  line per launch/attach/disconnect request — {command, arguments,
//  adapterCwd} — the wire-body witness for the start and detach proofs.
// ============================================================================

import { appendFileSync } from 'node:fs'

let buffer = Buffer.alloc(0)
let seq = 1000
let launchReq = null
let configDone = false
let breakpointsSet = false
const TERMINATE_CAP = process.env.MOCK_DAP_TERMINATE_CAP === '1'
const TRACE = process.env.MOCK_DAP_TRACE ?? ''

function trace(req) {
  if (!TRACE) return
  try {
    appendFileSync(
      TRACE,
      `${JSON.stringify({ command: req.command, arguments: req.arguments ?? {}, adapterCwd: process.cwd() })}\n`,
    )
  } catch {
    // the trace is a witness, never the adapter's failure
  }
}

function send(msg) {
  const payload = JSON.stringify({ seq: seq++, ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`)
}
function respond(req, body = {}, success = true, message = undefined) {
  send({ type: 'response', request_seq: req.seq, command: req.command, success, body, message })
}
function event(name, body = {}) {
  send({ type: 'event', event: name, body })
}

function maybeFinishLaunch() {
  if (launchReq && configDone) {
    respond(launchReq, {})
    launchReq = null
    event('output', { category: 'stdout', output: 'mock: started\n' })
    if (breakpointsSet) {
      setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 1 }), 20)
    }
  }
}

function handle(req) {
  switch (req.command) {
    case 'initialize':
      // Capability surface: loadedSources/setVariable/
      // exception filters supported; modules + completions deliberately NOT
      // advertised — the proof's precise-unsupported paths.
      respond(req, {
        supportsConfigurationDoneRequest: true,
        supportsLoadedSourcesRequest: true,
        supportsSetVariable: true,
        ...(TERMINATE_CAP ? { supportTerminateDebuggee: true } : {}),
        exceptionBreakpointFilters: [
          { filter: 'raised', label: 'Raised Exceptions' },
          { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
        ],
      })
      event('initialized')
      break
    case 'loadedSources':
      respond(req, {
        sources: [
          { name: 'demo.py', path: '/tmp/demo.py' },
          { name: '<generated>', sourceReference: 7 },
        ],
      })
      break
    case 'source':
      respond(
        req,
        req.arguments?.sourceReference === 7
          ? { content: 'generated line 1\ngenerated line 2\n' }
          : {},
        req.arguments?.sourceReference === 7,
        req.arguments?.sourceReference === 7 ? undefined : 'unknown sourceReference',
      )
      break
    case 'setExceptionBreakpoints':
      respond(req, {})
      break
    case 'setVariable':
      respond(
        req,
        req.arguments?.name === 'x'
          ? { value: String(req.arguments?.value ?? ''), type: 'int' }
          : {},
        req.arguments?.name === 'x',
        req.arguments?.name === 'x' ? undefined : 'unknown variable',
      )
      break
    case 'setBreakpoints': {
      const lines = (req.arguments?.breakpoints ?? []).map(b => b.line)
      // MOCK_DAP_REFUSE_BREAKPOINTS=1: the adapter refuses the source (no
      // symbols) — the launch-round proof's refused shape. Nothing stops.
      if (process.env.MOCK_DAP_REFUSE_BREAKPOINTS === '1') {
        respond(req, {}, false, `no symbols loaded for ${String(req.arguments?.source?.path ?? '?')}`)
        break
      }
      breakpointsSet = breakpointsSet || lines.length > 0
      const answer = () => respond(req, { breakpoints: lines.map(line => ({ verified: true, line })) })
      // MOCK_DAP_BREAKPOINT_DELAY_MS: cold symbol loading — the answer comes
      // after the delay (the generic request deadline is 8s).
      const delay = Number(process.env.MOCK_DAP_BREAKPOINT_DELAY_MS ?? '0')
      if (delay > 0) setTimeout(answer, delay)
      else answer()
      break
    }
    case 'configurationDone':
      configDone = true
      respond(req, {})
      maybeFinishLaunch()
      break
    case 'launch':
    case 'attach': // attach rides the same choreography (the unity-row pins)
      trace(req)
      launchReq = req
      maybeFinishLaunch()
      break
    case 'threads':
      respond(req, { threads: [{ id: 1, name: 'MainThread' }] })
      break
    case 'stackTrace':
      respond(req, {
        stackFrames: [
          { id: 1000, name: 'main', line: 3, source: { path: '/tmp/demo.py' } },
          { id: 1001, name: 'caller', line: 9, source: { path: '/tmp/demo.py' } },
        ],
        totalFrames: 2,
      })
      break
    case 'scopes':
      respond(req, { scopes: [{ name: 'Locals', variablesReference: 100 }] })
      break
    case 'variables':
      respond(
        req,
        req.arguments?.variablesReference === 100
          ? { variables: [{ name: 'x', value: '41', type: 'int' }] }
          : { variables: [] },
      )
      break
    case 'evaluate':
      respond(
        req,
        req.arguments?.expression === 'x+1'
          ? { result: '42', type: 'int' }
          : { result: `eval(${String(req.arguments?.expression ?? '')})` },
      )
      break
    case 'continue':
      respond(req, { allThreadsContinued: true })
      event('continued', { threadId: 1 })
      setTimeout(() => {
        event('output', { category: 'stdout', output: 'mock: done\n' })
        event('terminated')
        event('exited', { exitCode: 0 })
      }, 20)
      break
    case 'next':
    case 'stepIn':
    case 'stepOut':
      respond(req, {})
      setTimeout(() => event('stopped', { reason: 'step', threadId: 1 }), 15)
      break
    case 'pause':
      respond(req, {})
      event('stopped', { reason: 'pause', threadId: 1 })
      break
    case 'disconnect':
      trace(req)
      respond(req, {})
      setTimeout(() => process.exit(0), 10)
      break
    default:
      respond(req, {}, false, `mock adapter: unknown command ${req.command}`)
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const m = buffer.subarray(0, headerEnd).toString('utf-8').match(/Content-Length:\s*(\d+)/i)
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(m[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf-8')
    buffer = buffer.subarray(start + length)
    try {
      handle(JSON.parse(body))
    } catch {
      // ignore unparseable frames
    }
  }
})
process.stdin.on('end', () => process.exit(0))
