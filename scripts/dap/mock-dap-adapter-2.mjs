#!/usr/bin/env node
// ============================================================================
//  mock-dap-adapter-2.mjs — the breadth-proof DAP responder. Beside the
//  original mock (which prove-dap.ts pins), this one exercises the C2
//  additions: tcp serving with a substituted port, attach-body recording,
//  conditional-breakpoint verification honesty, a never-stopping continue,
//  and custom-request echoes.
//
//  Modes:
//    argv[2] = a PORT  → listen on 127.0.0.1:port and frame on the socket
//    otherwise         → stdio frames
//    MOCK2_NEVER_STOP=1 → 'continue' succeeds and the debuggee never stops
//
//  Custom requests: mock/lastAttach (the recorded attach body), mock/argv
//  (this process's argv tail), mock/echo (echoes its arguments back).
// ============================================================================
import { createServer } from 'node:net'

const portArg = process.argv[2]
const neverStop = process.env.MOCK2_NEVER_STOP === '1'

let wire = null
let seq = 1000
let buffer = Buffer.alloc(0)
let lastAttach = null
let launchReq = null
let configDone = false
let sawBreakpoints = false
let attached = false

function send(msg) {
  const payload = JSON.stringify({ seq: seq++, ...msg })
  wire.write(`Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`)
}
function respond(req, body = {}, success = true, message = undefined) {
  send({ type: 'response', request_seq: req.seq, command: req.command, success, body, message })
}
function event(name, body = {}) {
  send({ type: 'event', event: name, body })
}

function maybeStart() {
  if (launchReq && configDone) {
    respond(launchReq, {})
    launchReq = null
    if (attached || sawBreakpoints) {
      setTimeout(() => {
        if (!neverStop) event('stopped', { reason: attached ? 'attach' : 'breakpoint', threadId: 1 })
      }, 30)
    }
  }
}

function handle(req) {
  switch (req.command) {
    case 'initialize':
      respond(req, {
        supportsConfigurationDoneRequest: true,
        supportsConditionalBreakpoints: true,
        // hit-count breakpoints DELIBERATELY not advertised — the precise
        // capability-refusal path.
      })
      event('initialized')
      break
    case 'launch':
    case 'attach':
      if (req.command === 'attach') {
        lastAttach = req.arguments ?? {}
        attached = true
      }
      launchReq = req
      maybeStart()
      break
    case 'setBreakpoints': {
      sawBreakpoints = true
      const requested = (req.arguments && req.arguments.breakpoints) || []
      // Verification honesty: a condition must look like `<ident> == <num>`
      // to verify; anything else is UNVERIFIED with a named reason.
      const breakpoints = requested.map(b => {
        if (b.condition !== undefined && !/^\s*\w+\s*==\s*\d+\s*$/.test(b.condition)) {
          return { line: b.line, verified: false, message: `unparseable condition: ${b.condition}` }
        }
        return { line: b.line, verified: true }
      })
      respond(req, { breakpoints })
      break
    }
    case 'configurationDone':
      configDone = true
      respond(req, {})
      maybeStart()
      break
    case 'threads':
      respond(req, { threads: [{ id: 1, name: 'MainThread' }] })
      break
    case 'stackTrace':
      respond(req, {
        stackFrames: [{ id: 7, name: 'main', line: 3, source: { path: '/tmp/mock2/demo.m2' } }],
        totalFrames: 1,
      })
      break
    case 'continue':
      // The still-running case: succeed, then never stop again.
      respond(req, { allThreadsContinued: true })
      break
    case 'pause':
      respond(req, {})
      setTimeout(() => event('stopped', { reason: 'pause', threadId: 1 }), 20)
      break
    case 'mock/lastAttach':
      respond(req, { lastAttach })
      break
    case 'mock/argv':
      respond(req, { argv: process.argv.slice(2) })
      break
    case 'mock/echo':
      respond(req, { echoed: req.arguments ?? null })
      break
    case 'disconnect':
      respond(req, {})
      setTimeout(() => process.exit(0), 10)
      break
    default:
      respond(req, {}, true)
  }
}

function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.slice(0, headerEnd).toString('utf8')
    const m = /Content-Length: (\d+)/i.exec(header)
    if (!m) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }
    const len = Number(m[1])
    const start = headerEnd + 4
    if (buffer.length < start + len) return
    const body = buffer.slice(start, start + len).toString('utf8')
    buffer = buffer.slice(start + len)
    try {
      handle(JSON.parse(body))
    } catch {
      // malformed frames are the driver's problem
    }
  }
}

if (portArg && /^\d+$/.test(portArg)) {
  const server = createServer(socket => {
    wire = socket
    socket.on('data', onData)
    socket.on('close', () => process.exit(0))
  })
  server.listen(Number(portArg), '127.0.0.1')
} else {
  wire = process.stdout
  process.stdin.on('data', onData)
}
