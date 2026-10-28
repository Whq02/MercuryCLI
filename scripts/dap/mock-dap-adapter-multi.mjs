#!/usr/bin/env node

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
const NO_CONDITIONS = process.env.MOCK_MULTI_NO_CONDITIONS === '1'
const EXIT_CODE = Number(process.env.MOCK_MULTI_EXIT_CODE ?? '0')
const PRINTED_EXIT = process.env.MOCK_MULTI_PRINTED_EXIT === '1'

let childrenExpected = CHILDREN + (GRANDCHILD ? 1 : 0)
let childrenTerminated = 0
let parentSession = null
let lastStack = null

function onChildTerminated() {
  childrenTerminated++
  if (!LINGERS && parentSession && childrenTerminated >= childrenExpected) {
    parentSession.event('terminated')
    parentSession.event('exited', { exitCode: 0 })
  }
}

function makeSession(write, onDisconnect) {
  let seq = 1000
  let role = null
  let childId = ''
  let launchReq = null
  let configDone = false
  let breakpointsSet = false
  let bpLines = []
  let initArgs = {}
  let grandchildFired = false
  let reverseSeq = 0
  const reverseSent = new Map()
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
        event('process', { name: '/tmp/demo.js', startMethod: 'launch', isLocalProcess: true })
        event('thread', { reason: 'started', threadId: 1 })
      }
      setTimeout(fireReverseRequests, 10)
      return
    }
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
      return
    }
    if (CHILD_SILENT) return
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
        if (PRINTED_EXIT) event('output', { category: 'stdout', output: `Process exited with code ${EXIT_CODE}\n` })
        else event('exited', { exitCode: EXIT_CODE })
        onChildTerminated()
      }, 30)
    }
  }

  function handle(msg) {
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
        respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsFunctionBreakpoints: true,
          ...(NO_CONDITIONS ? {} : { supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true }),
        })
        event('initialized')
        break
      case 'setFunctionBreakpoints': {
        const rows = req.arguments?.breakpoints ?? []
        event('output', {
          category: 'stdout',
          output: `[mock] ${role === 'parent' ? 'parent' : `child ${childId}`} setFunctionBreakpoints ${JSON.stringify(rows)}\n`,
        })
        respond(req, { breakpoints: rows.map((b, i) => ({ verified: role !== 'parent', id: 800 + i })) })
        break
      }
      case 'setBreakpoints': {
        const lines = (req.arguments?.breakpoints ?? []).map(b => b.line)
        breakpointsSet = breakpointsSet || lines.length > 0
        if (lines.length > 0) bpLines = lines
        event('output', {
          category: 'stdout',
          output: `[mock] ${role === 'parent' ? 'parent' : `child ${childId}`} setBreakpoints ${String(req.arguments?.source?.path ?? '?')} lines=[${lines.join(',')}]\n`,
        })
        const verified = role !== 'parent' && !LAZY_VERIFY
        respond(req, { breakpoints: lines.map(line => ({ verified, line, id: 700 + line })) })
        break
      }
      case 'mock/spawnChild': {
        const name = typeof req.arguments?.name === 'string' ? req.arguments.name : 'child-late'
        const id = typeof req.arguments?.id === 'string' ? req.arguments.id : 'target-late'
        childrenExpected++
        respond(req, { name, id })
        sendReverse('startDebugging', {
          request: 'launch',
          configuration: { type: 'mock-multi', name, __pendingTargetId: id, program: '/tmp/demo.js' },
        })
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
      case 'mock/lastStack':
        respond(req, lastStack ?? {})
        break
      case 'stackTrace':
        lastStack = req.arguments
        respond(req, {
          stackFrames: [
            { id: 210, name: 'childMain', line: 3, source: { path: '/tmp/demo.js' } },
            { id: 211, name: 'childCaller', line: 9, source: { path: '/tmp/demo.js' } },
          ].slice(0, req.arguments?.levels ?? 2),
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
          if (PRINTED_EXIT) event('output', { category: 'stdout', output: `Process exited with code ${EXIT_CODE}\n` })
        else event('exited', { exitCode: EXIT_CODE })
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
  const session = makeSession(frameWriter(process.stdout), () => process.exit(0))
  process.stdin.on('data', makeFrameParser(session.handle))
  process.stdin.on('end', () => process.exit(0))
}
