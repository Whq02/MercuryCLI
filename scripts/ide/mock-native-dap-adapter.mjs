#!/usr/bin/env node
// ============================================================================
//  mock-native-dap-adapter.mjs — the slice-5 deterministic DAP
//  responder for scripts/ide/prove-native-debug.ts. Extends the dap suite's
//  mock pattern (scripts/dap/mock-dap-adapter.mjs, deliberately untouched)
//  with the NATIVE op surface: attach, rich breakpoints (condition/
//  hitCondition/logMessage echoed back on the breakpoint `message` so the
//  proof can assert the round-trip), function breakpoints, disassemble,
//  readMemory, stepping granularity (echoed in the stop description), and
//  restart. `--bare` advertises NOTHING beyond configurationDone — the
//  precise-refusal legs. No dependencies.
//
//  Fixtures: thread 1/MainThread; frames main(demo.c:4, ip 0xdead0000) +
//  caller(demo.c:9, ip 0xdead0040); Locals ref 100 holding x=41;
//  evaluate('x+1') = 42; disassemble at 0xdead0000 = 4 fixed instructions;
//  readMemory at 0xdead0000 = the ASCII bytes 'MERCURY-NATIVE-DEBUG'.
// ============================================================================

const BARE = process.argv.includes('--bare')

let buffer = Buffer.alloc(0)
let seq = 1000
let startReq = null // launch OR attach — same finish choreography
let configDone = false
let breakpointsSet = false

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

function maybeFinishStart() {
  if (startReq && configDone) {
    const wasAttach = startReq.command === 'attach'
    respond(startReq, {})
    startReq = null
    event('output', { category: 'stdout', output: `mock-native: ${wasAttach ? 'attached' : 'started'}\n` })
    // attach stops immediately (the joined process is halted for inspection);
    // launch stops only when breakpoints were configured.
    if (wasAttach) {
      setTimeout(() => event('stopped', { reason: 'attach', threadId: 1 }), 20)
    } else if (breakpointsSet) {
      setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 1 }), 20)
    }
  }
}

function handle(req) {
  switch (req.command) {
    case 'initialize':
      respond(
        req,
        BARE
          ? { supportsConfigurationDoneRequest: true }
          : {
              supportsConfigurationDoneRequest: true,
              supportsConditionalBreakpoints: true,
              supportsHitConditionalBreakpoints: true,
              supportsLogPoints: true,
              supportsFunctionBreakpoints: true,
              supportsDisassembleRequest: true,
              supportsReadMemoryRequest: true,
              supportsSteppingGranularity: true,
              supportsRestartRequest: true,
            },
      )
      event('initialized')
      break
    case 'setBreakpoints': {
      const bps = req.arguments?.breakpoints ?? []
      breakpointsSet = breakpointsSet || bps.length > 0
      // Echo the rich fields back on `message` — the proof's round-trip pin.
      respond(req, {
        breakpoints: bps.map(b => {
          const tags = []
          if (b.condition !== undefined) tags.push(`cond:${b.condition}`)
          if (b.hitCondition !== undefined) tags.push(`hits:${b.hitCondition}`)
          if (b.logMessage !== undefined) tags.push(`log:${b.logMessage}`)
          return { verified: true, line: b.line, ...(tags.length ? { message: tags.join(' ') } : {}) }
        }),
      })
      break
    }
    case 'setFunctionBreakpoints': {
      const bps = req.arguments?.breakpoints ?? []
      respond(req, {
        breakpoints: bps.map(b => ({
          verified: b.name === 'compute',
          ...(b.name === 'compute' ? {} : { message: `no symbol ${b.name}` }),
        })),
      })
      break
    }
    case 'configurationDone':
      configDone = true
      respond(req, {})
      maybeFinishStart()
      break
    case 'launch':
    case 'attach':
      startReq = req
      maybeFinishStart()
      break
    case 'restart':
      respond(req, {})
      event('output', { category: 'stdout', output: 'mock-native: restarted\n' })
      setTimeout(() => event('stopped', { reason: 'entry', threadId: 1, description: 'restarted' }), 20)
      break
    case 'threads':
      respond(req, { threads: [{ id: 1, name: 'MainThread' }] })
      break
    case 'stackTrace':
      respond(req, {
        stackFrames: [
          {
            id: 1000,
            name: 'main',
            line: 4,
            source: { path: '/tmp/demo.c' },
            instructionPointerReference: '0xdead0000',
          },
          {
            id: 1001,
            name: 'caller',
            line: 9,
            source: { path: '/tmp/demo.c' },
            instructionPointerReference: '0xdead0040',
          },
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
    case 'disassemble':
      respond(
        req,
        req.arguments?.memoryReference === '0xdead0000'
          ? {
              instructions: [
                { address: '0xdead0000', instruction: 'push rbp', symbol: 'main' },
                { address: '0xdead0001', instruction: 'mov rbp, rsp' },
                { address: '0xdead0004', instruction: 'mov eax, 42' },
                { address: '0xdead0009', instruction: 'ret' },
              ].slice(0, Math.max(1, Math.min(Number(req.arguments?.instructionCount ?? 4), 4))),
            }
          : {},
        req.arguments?.memoryReference === '0xdead0000',
        req.arguments?.memoryReference === '0xdead0000' ? undefined : 'unknown memory reference',
      )
      break
    case 'readMemory': {
      const bytes = Buffer.from('MERCURY-NATIVE-DEBUG', 'ascii')
      const count = Math.max(0, Math.min(Number(req.arguments?.count ?? bytes.length), bytes.length))
      respond(
        req,
        req.arguments?.memoryReference === '0xdead0000'
          ? { address: '0xdead0000', data: bytes.subarray(0, count).toString('base64'), unreadableBytes: 0 }
          : {},
        req.arguments?.memoryReference === '0xdead0000',
        req.arguments?.memoryReference === '0xdead0000' ? undefined : 'unknown memory reference',
      )
      break
    }
    case 'continue':
      respond(req, { allThreadsContinued: true })
      event('continued', { threadId: 1 })
      setTimeout(() => {
        event('output', { category: 'stdout', output: 'mock-native: done\n' })
        event('terminated')
        event('exited', { exitCode: 0 })
      }, 20)
      break
    case 'next':
    case 'stepIn':
    case 'stepOut':
      respond(req, {})
      // Echo the granularity so the proof can assert it was actually passed.
      setTimeout(
        () =>
          event('stopped', {
            reason: 'step',
            threadId: 1,
            description: `step(${String(req.arguments?.granularity ?? 'statement')})`,
          }),
        15,
      )
      break
    case 'pause':
      respond(req, {})
      event('stopped', { reason: 'pause', threadId: 1 })
      break
    case 'disconnect':
      respond(req, {})
      setTimeout(() => process.exit(0), 10)
      break
    default:
      respond(req, {}, false, `mock-native adapter: unknown command ${req.command}`)
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
