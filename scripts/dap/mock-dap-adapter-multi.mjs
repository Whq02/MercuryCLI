#!/usr/bin/env node
// ============================================================================
//  mock-dap-adapter-multi.mjs — a deterministic MULTI-SESSION DAP adapter
//  (the parent/child shape) for scripts/dap/prove-dap-multisession.ts.
//
//  Two transports, the two real child-session shapes:
//   · TCP server mode (argv: <port> [host]) — the js-debug dapDebugServer
//     contract: every TCP connection is ONE session; the connection's
//     launch/attach body routes it — no __pendingTargetId ⇒ a top-level
//     (parent) session, __pendingTargetId present ⇒ the awaited child.
//   · stdio mode (no argv port) — the debugpy shape: the client spawns a
//     FRESH adapter process per child; the start body's __pendingTargetId
//     tells the process it IS the child.
//
//  Parent choreography: initialize (initialized event immediately, like the
//  single-session mock) → launch: the client MUST have advertised
//  supportsStartDebuggingRequest or launch is REFUSED (the js-debug boundary
//  the child-session road exists to cross — the red-first control) →
//  setBreakpoints answers verified:false (a multi-session parent binds
//  nothing; the child is the verifier — the js-debug truth) →
//  configurationDone → launch OK → reverse requests per knob → every
//  reverse-request RESPONSE the client sends back is echoed into an output
//  event: `[mock] <command>#<n> success=<s> message=<m>` (the ring is how
//  the prover reads refusal truth). TCP mode: when every expected child has
//  terminated, the parent emits terminated (js-debug ends the run when its
//  targets are gone) unless MOCK_MULTI_PARENT_LINGERS=1 — and stdio mode
//  always lingers (a separate-process parent cannot see its children).
//
//  Child choreography: initialize → initialized → setBreakpoints verified
//  TRUE → configurationDone → launch OK → output `[mock] child <id> up` →
//  stopped(breakpoint, thread 11) when breakpoints were set, else run to
//  completion (output `mock-child: ran` + terminated + exited).
//  Fixtures: thread 11 'mock-child' · frames childMain(demo.js:3) frameId
//  210 + childCaller(demo.js:9) frameId 211 · Locals ref 300 · a=41, b=1 ·
//  evaluate 'a+b' = 42 · continue → output `mock-child: done` + terminated.
//
//  Knobs (env): MOCK_MULTI_CHILDREN=<n> (default 1) ·
//  MOCK_MULTI_PARENT_LINGERS=1 · MOCK_MULTI_RUNINTERMINAL=1 (parent fires a
//  runInTerminal reverse request first) · MOCK_MULTI_UNKNOWN_REVERSE=1
//  (parent fires a bogus reverse request) · MOCK_MULTI_GRANDCHILD=1 (the
//  first CHILD fires its own startDebugging; the grandchild is the one that
//  stops — the depth road) · MOCK_MULTI_CHILD_SILENT=1 (children neither
//  stop nor terminate — the ambiguity fixture) · MOCK_MULTI_LAZY_VERIFY=1
//  (the child answers setBreakpoints UNVERIFIED and verifies through
//  breakpoint-changed events before stopping — the js-debug lazy-verifier
//  shape the live drill surfaced) · MOCK_MULTI_ROOT_HOSTS=1 (the parent
//  HOSTS a debuggee of its own, the debugpy root shape: process + thread
//  events follow its launch response, it keeps running after its children
//  end, and its own continue ends it). No dependencies.
// ============================================================================

import { createServer } from 'node:net'

const tcpPort = process.argv[2] ? Number(process.argv[2]) : null
const tcpHost = process.argv[3] ?? '127.0.0.1'
const CHILDREN = Math.max(1, Number(process.env.MOCK_MULTI_CHILDREN ?? '1'))
const LINGERS = process.env.MOCK_MULTI_PARENT_LINGERS === '1' || tcpPort === null
const RUNINTERMINAL = process.env.MOCK_MULTI_RUNINTERMINAL === '1'
const UNKNOWN_REVERSE = process.env.MOCK_MULTI_UNKNOWN_REVERSE === '1'
const GRANDCHILD = process.env.MOCK_MULTI_GRANDCHILD === '1'
const CHILD_SILENT = process.env.MOCK_MULTI_CHILD_SILENT === '1'
const LAZY_VERIFY = process.env.MOCK_MULTI_LAZY_VERIFY === '1'
const ROOT_HOSTS = process.env.MOCK_MULTI_ROOT_HOSTS === '1'

const childrenExpected = CHILDREN + (GRANDCHILD ? 1 : 0)
let childrenTerminated = 0
let parentSession = null

function onChildTerminated() {
  childrenTerminated++
  if (!LINGERS && parentSession && childrenTerminated >= childrenExpected) {
    parentSession.event('terminated')
    parentSession.event('exited', { exitCode: 0 })
  }
}

/** One DAP session over one wire (a socket, or the stdio pipes). */
function makeSession(write, onDisconnect) {
  let seq = 1000
  let role = null // 'parent' | 'child'
  let childId = ''
  let launchReq = null
  let configDone = false
  let breakpointsSet = false
  let bpLines = []
  let initArgs = {}
  let grandchildFired = false
  let reverseSeq = 0
  const reverseSent = new Map() // seq → { command, index }
  let reverseIndex = 0

  const send = msg => write({ seq: seq++, ...msg })
  const respond = (req, body = {}, success = true, message = undefined) =>
    send({ type: 'response', request_seq: req.seq, command: req.command, success, body, message })
  const event = (name, body = {}) => send({ type: 'event', event: name, body })
  const sendReverse = (command, args) => {
    const s = seq++
    reverseSent.set(s, { command, index: ++reverseIndex })
    write({ seq: s, type: 'request', command, arguments: args })
  }

  function fireReverseRequests() {
    if (RUNINTERMINAL) {
      sendReverse('runInTerminal', { kind: 'integrated', cwd: '/tmp', args: ['echo', 'hi'] })
    }
    if (UNKNOWN_REVERSE) {
      sendReverse('mercuryNoSuchReverse', {})
    }
    for (let i = 1; i <= CHILDREN; i++) {
      sendReverse('startDebugging', {
        request: 'launch',
        configuration: {
          type: 'mock-multi',
          name: `child-${i}`,
          __pendingTargetId: `target-${i}`,
          program: '/tmp/demo.js',
        },
      })
    }
  }

  function maybeFinishLaunch() {
    if (!launchReq || !configDone) return
    const req = launchReq
    launchReq = null
    if (role === 'parent') {
      respond(req, {})
      if (ROOT_HOSTS) {
        // The debugpy root shape: the parent runs the main program itself.
        event('process', { name: '/tmp/demo.js', startMethod: 'launch', isLocalProcess: true })
        event('thread', { reason: 'started', threadId: 1 })
      }
      setTimeout(fireReverseRequests, 10)
      return
    }
    // child
    respond(req, {})
    event('output', { category: 'stdout', output: `[mock] child ${childId} up\n` })
    const isSilentLeader = GRANDCHILD && childId === 'target-1'
    if (isSilentLeader && !grandchildFired) {
      grandchildFired = true
      setTimeout(
        () =>
          sendReverse('startDebugging', {
            request: 'launch',
            configuration: {
              type: 'mock-multi',
              name: 'grandchild',
              __pendingTargetId: 'target-g1',
              program: '/tmp/demo.js',
            },
          }),
        10,
      )
      return // the leader neither stops nor terminates while its grandchild debugs
    }
    if (CHILD_SILENT) return // neither stops nor terminates — the ambiguity fixture
    if (breakpointsSet) {
      if (LAZY_VERIFY) {
        setTimeout(() => {
          for (const line of bpLines) {
            event('breakpoint', { reason: 'changed', breakpoint: { id: 700 + line, line, verified: true } })
          }
        }, 12)
      }
      setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 11 }), 25)
    } else {
      setTimeout(() => {
        event('output', { category: 'stdout', output: 'mock-child: ran\n' })
        event('terminated')
        event('exited', { exitCode: 0 })
        onChildTerminated()
      }, 30)
    }
  }

  function handle(msg) {
    // Reverse-request RESPONSES from the client land here — echo them into
    // the output ring so the prover can read refusal truth as text.
    if (msg.type === 'response') {
      const sent = reverseSent.get(msg.request_seq)
      if (sent) {
        reverseSent.delete(msg.request_seq)
        event('output', {
          category: 'stdout',
          output: `[mock] ${sent.command}#${sent.index} success=${msg.success === true}${msg.message ? ` message=${msg.message}` : ''}\n`,
        })
      }
      return
    }
    if (msg.type !== 'request') return
    const req = msg
    switch (req.command) {
      case 'initialize':
        initArgs = req.arguments ?? {}
        respond(req, { supportsConfigurationDoneRequest: true })
        event('initialized')
        break
      case 'setBreakpoints': {
        const lines = (req.arguments?.breakpoints ?? []).map(b => b.line)
        breakpointsSet = breakpointsSet || lines.length > 0
        if (lines.length > 0) bpLines = lines
        // The multi-session truth: the parent binds nothing (verified:false);
        // the child is the verifier — and a LAZY child (js-debug) verifies
        // through breakpoint-changed events, not the response.
        const verified = role !== 'parent' && !LAZY_VERIFY
        respond(req, { breakpoints: lines.map(line => ({ verified, line, id: 700 + line })) })
        break
      }
      case 'configurationDone':
        configDone = true
        respond(req, {})
        maybeFinishLaunch()
        break
      case 'launch':
      case 'attach': {
        const pendingId = req.arguments?.__pendingTargetId
        if (typeof pendingId === 'string' && pendingId) {
          role = 'child'
          childId = pendingId
        } else {
          role = 'parent'
          parentSession = api
          if (initArgs.supportsStartDebuggingRequest !== true) {
            respond(
              req,
              {},
              false,
              'client lacks supportsStartDebuggingRequest — a multi-session adapter cannot start its child sessions',
            )
            break
          }
        }
        // Echo a runtimeArgs key VERBATIM when the body carries one — the
        // pass-through pin's witness (absent key ⇒ no echo line at all).
        if (role === 'parent' && req.arguments && 'runtimeArgs' in req.arguments) {
          event('output', { category: 'stdout', output: `[mock] launch runtimeArgs ${JSON.stringify(req.arguments.runtimeArgs)}\n` })
        }
        launchReq = req
        maybeFinishLaunch()
        break
      }
      case 'threads':
        respond(req, { threads: [{ id: 11, name: 'mock-child' }] })
        break
      case 'stackTrace':
        respond(req, {
          stackFrames: [
            { id: 210, name: 'childMain', line: 3, source: { path: '/tmp/demo.js' } },
            { id: 211, name: 'childCaller', line: 9, source: { path: '/tmp/demo.js' } },
          ],
          totalFrames: 2,
        })
        break
      case 'scopes':
        respond(req, { scopes: [{ name: 'Locals', variablesReference: 300 }] })
        break
      case 'variables':
        respond(
          req,
          req.arguments?.variablesReference === 300
            ? { variables: [{ name: 'a', value: '41', type: 'number' }, { name: 'b', value: '1', type: 'number' }] }
            : { variables: [] },
        )
        break
      case 'evaluate':
        respond(
          req,
          req.arguments?.expression === 'a+b'
            ? { result: '42', type: 'number' }
            : { result: `eval(${String(req.arguments?.expression ?? '')})` },
        )
        break
      case 'continue':
        respond(req, { allThreadsContinued: true })
        event('continued', { threadId: 11 })
        setTimeout(() => {
          event('output', { category: 'stdout', output: 'mock-child: done\n' })
          event('terminated')
          event('exited', { exitCode: 0 })
          onChildTerminated()
        }, 20)
        break
      case 'next':
      case 'stepIn':
      case 'stepOut':
        respond(req, {})
        setTimeout(() => event('stopped', { reason: 'step', threadId: 11 }), 15)
        break
      case 'pause':
        respond(req, {})
        event('stopped', { reason: 'pause', threadId: 11 })
        break
      case 'disconnect':
        respond(req, {})
        setTimeout(onDisconnect, 10)
        break
      default:
        respond(req, {}, false, `mock-multi: unknown command ${req.command}`)
    }
  }

  const api = { handle, event }
  return api
}

/** Content-Length frame parser (one per wire). */
function makeFrameParser(onMessage) {
  let buffer = Buffer.alloc(0)
  return chunk => {
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
        onMessage(JSON.parse(body))
      } catch {
        // ignore unparseable frames
      }
    }
  }
}

function frameWriter(stream) {
  return msg => {
    const payload = JSON.stringify(msg)
    stream.write(`Content-Length: ${Buffer.byteLength(payload, 'utf-8')}\r\n\r\n${payload}`)
  }
}

if (tcpPort !== null) {
  // TCP server mode — the js-debug dapDebugServer shape.
  const server = createServer(socket => {
    const session = makeSession(frameWriter(socket), () => {
      socket.destroy()
      if (parentSession && session === parentSession) process.exit(0)
    })
    socket.on('data', makeFrameParser(session.handle))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (parentSession && session === parentSession) process.exit(0)
    })
  })
  server.listen(tcpPort, tcpHost)
} else {
  // stdio mode — the debugpy shape (one process per session).
  const session = makeSession(frameWriter(process.stdout), () => process.exit(0))
  process.stdin.on('data', makeFrameParser(session.handle))
  process.stdin.on('end', () => process.exit(0))
}
