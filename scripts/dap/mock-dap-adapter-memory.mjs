#!/usr/bin/env node
const BARE = process.argv.includes('--bare')
const REGION_BASE = 0x2000
const REGION_SIZE = 16

let buffer = Buffer.alloc(0)
let seq = 1000
let launchReq = null
let configDone = false
let breakpointsSet = false
let dataBreakpoints = []
let instructionBreakpoints = []
let dataHit = false
let instructionHit = false
const region = Buffer.alloc(REGION_SIZE)
region.write('MERCURY', 4, 'ascii')

function total() {
  return region.readInt32LE(0)
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
    event('output', { category: 'stdout', output: 'mock-memory: started\n' })
    if (breakpointsSet) {
      setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 1 }), 20)
    }
  }
}

function parseAddress(reference, offset) {
  const base = Number.parseInt(String(reference ?? ''), 16)
  if (!Number.isFinite(base)) return null
  return base + Number(offset ?? 0)
}

function armedDataAccess() {
  const armed = dataBreakpoints.find(b => b.dataId === 'total@100')
  if (!armed) return null
  return armed.accessType ?? 'write'
}

function handle(req) {
  const args = req.arguments ?? {}
  switch (req.command) {
    case 'initialize':
      respond(
        req,
        BARE
          ? { supportsConfigurationDoneRequest: true }
          : {
              supportsConfigurationDoneRequest: true,
              supportsDataBreakpoints: true,
              supportsInstructionBreakpoints: true,
              supportsReadMemoryRequest: true,
              supportsWriteMemoryRequest: true,
            },
      )
      event('initialized')
      break
    case 'setBreakpoints': {
      const lines = (args.breakpoints ?? []).map(b => b.line)
      breakpointsSet = breakpointsSet || lines.length > 0
      respond(req, { breakpoints: lines.map(line => ({ verified: true, line })) })
      break
    }
    case 'configurationDone':
      configDone = true
      respond(req, {})
      maybeFinishLaunch()
      break
    case 'launch':
    case 'attach':
      launchReq = req
      maybeFinishLaunch()
      break
    case 'threads':
      respond(req, { threads: [{ id: 1, name: 'MainThread' }] })
      break
    case 'stackTrace':
      respond(req, {
        stackFrames: [
          { id: 1000, name: 'compute', line: 4, source: { path: '/tmp/demo.c' }, instructionPointerReference: '0x1000' },
          { id: 1001, name: 'main', line: 9, source: { path: '/tmp/demo.c' }, instructionPointerReference: '0x1040' },
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
        args.variablesReference === 100
          ? {
              variables: [
                { name: 'total', value: String(total()), type: 'int', memoryReference: '0x2000' },
                { name: 'label', value: '"MERCURY"', type: 'char[8]', memoryReference: '0x2004' },
              ],
            }
          : { variables: [] },
      )
      break
    case 'evaluate':
      respond(req, { result: `eval(${String(args.expression ?? '')})` })
      break
    case 'dataBreakpointInfo':
      if (args.name === 'total' && args.variablesReference === 100) {
        respond(req, {
          dataId: 'total@100',
          description: 'total (int, 4 bytes at 0x2000)',
          accessTypes: ['read', 'write', 'readWrite'],
          canPersist: false,
        })
      } else if (args.name === 'label' && args.variablesReference === 100) {
        respond(req, { dataId: 'label@100', description: 'label (char[8] at 0x2004)', accessTypes: ['write'] })
      } else {
        respond(req, { dataId: null, description: `no such variable ${String(args.name ?? '?')}` })
      }
      break
    case 'setDataBreakpoints':
      dataBreakpoints = args.breakpoints ?? []
      dataHit = false
      respond(req, {
        breakpoints: dataBreakpoints.map((b, i) => {
          const known = b.dataId === 'total@100' || b.dataId === 'label@100'
          return { id: 500 + i, verified: known, ...(known ? {} : { message: `unknown dataId ${String(b.dataId)}` }) }
        }),
      })
      break
    case 'setInstructionBreakpoints':
      instructionBreakpoints = args.breakpoints ?? []
      instructionHit = false
      respond(req, {
        breakpoints: instructionBreakpoints.map((b, i) => {
          const known = b.instructionReference === '0x1000'
          return {
            id: 700 + i,
            verified: known,
            ...(known ? { instructionReference: b.instructionReference, offset: b.offset ?? 0 } : { message: `no instruction at ${String(b.instructionReference)}` }),
          }
        }),
      })
      break
    case 'readMemory': {
      const address = parseAddress(args.memoryReference, args.offset)
      if (address === null || address < REGION_BASE || address >= REGION_BASE + REGION_SIZE) {
        respond(req, {}, false, `unreadable memory reference ${String(args.memoryReference)}`)
        break
      }
      const start = address - REGION_BASE
      const count = Math.max(0, Number(args.count ?? 0))
      const slice = region.subarray(start, Math.min(REGION_SIZE, start + count))
      respond(req, {
        address: `0x${address.toString(16)}`,
        data: slice.toString('base64'),
        unreadableBytes: count - slice.length,
      })
      break
    }
    case 'writeMemory': {
      const address = parseAddress(args.memoryReference, args.offset)
      const bytes = Buffer.from(String(args.data ?? ''), 'base64')
      if (address === null || address < REGION_BASE || address >= REGION_BASE + REGION_SIZE) {
        respond(req, {}, false, `unwritable memory reference ${String(args.memoryReference)}`)
        break
      }
      const start = address - REGION_BASE
      const room = REGION_SIZE - start
      if (bytes.length > room && !args.allowPartial) {
        respond(req, {}, false, `write of ${bytes.length} bytes at 0x${address.toString(16)} exceeds the writable region by ${bytes.length - room}`)
        break
      }
      const written = bytes.subarray(0, Math.min(room, bytes.length))
      written.copy(region, start)
      respond(req, { offset: 0, bytesWritten: written.length })
      break
    }
    case 'continue': {
      respond(req, { allThreadsContinued: true })
      event('continued', { threadId: 1 })
      const access = armedDataAccess()
      if (access !== null && !dataHit) {
        dataHit = true
        const before = total()
        region.writeInt32LE(7, 0)
        setTimeout(
          () =>
            event('stopped', {
              reason: 'data breakpoint',
              threadId: 1,
              description: `${access === 'read' ? 'read of' : 'write to'} total: ${before} -> ${total()}`,
            }),
          20,
        )
        break
      }
      if (instructionBreakpoints.some(b => b.instructionReference === '0x1000') && !instructionHit) {
        instructionHit = true
        const armed = instructionBreakpoints.find(b => b.instructionReference === '0x1000')
        setTimeout(
          () =>
            event('stopped', {
              reason: 'instruction breakpoint',
              threadId: 1,
              description: `at 0x1000+${Number(armed.offset ?? 0)}`,
            }),
          20,
        )
        break
      }
      setTimeout(() => {
        event('output', { category: 'stdout', output: `mock-memory: total=${total()}\n` })
        event('terminated')
        event('exited', { exitCode: 0 })
      }, 20)
      break
    }
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
    case 'mock/state':
      respond(req, {
        dataBreakpoints,
        instructionBreakpoints,
        total: total(),
        region: region.toString('hex'),
      })
      break
    case 'disconnect':
      respond(req, {})
      setTimeout(() => process.exit(0), 10)
      break
    default:
      respond(req, {}, false, `mock-memory adapter: unknown command ${req.command}`)
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
    } catch (err) {
      void err
    }
  }
})
process.stdin.on('end', () => process.exit(0))
