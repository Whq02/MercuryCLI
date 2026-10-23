#!/usr/bin/env node
let buffer = Buffer.alloc(0)
let seq = 1000
let initialized = {}
let launch
let configured = false
const reverse = new Map()
const send = msg => {
  const body = JSON.stringify({ seq: seq++, ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const reply = (req, body = {}, success = true, message) => send({ type: 'response', request_seq: req.seq, command: req.command, body, success, message })
const event = (name, body = {}) => send({ type: 'event', event: name, body })
function start() {
  if (!launch || !configured) return
  const req = launch
  launch = undefined
  if (req.arguments?.program === 'stalled-initialize') return
  reply(req)
  event('stopped', { reason: 'entry', threadId: 1 })
}
function handle(req) {
  if (req.type === 'response') {
    const waiting = reverse.get(req.request_seq)
    if (waiting) { reverse.delete(req.request_seq); reply(waiting, { response: req }) }
    return
  }
  switch (req.command) {
    case 'initialize':
      initialized = req.arguments
      reply(req, { supportsConfigurationDoneRequest: true, supportsRestartRequest: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsWriteMemoryRequest: true })
      if (process.env.MOCK_DAP_STALL_INITIALIZED !== '1') event('initialized')
      break
    case 'launch': case 'attach': launch = req; start(); break
    case 'configurationDone': configured = true; reply(req); start(); break
    case 'mock/capabilities': reply(req, initialized); break
    case 'mock/terminal': {
      const id = seq
      reverse.set(id, req)
      send({ type: 'request', command: 'runInTerminal', arguments: req.arguments })
      break
    }
    case 'mock/terminate': reply(req); event('terminated'); break
    case 'mock/stall': break
    case 'continue': case 'next': case 'stepIn': case 'stepOut': case 'pause': case 'restart':
      reply(req)
      event('continued', { threadId: 1 })
      if (process.env.MOCK_DAP_STOP_AFTER_MS) setTimeout(() => event('stopped', { reason: 'step', threadId: 1 }), Number(process.env.MOCK_DAP_STOP_AFTER_MS))
      break
    case 'threads': reply(req, { threads: [{ id: 1, name: 'fixture' }] }); break
    case 'stackTrace': reply(req, { stackFrames: [{ id: 1, name: 'fixture', line: 1, source: { name: 'fixture' } }] }); break
    case 'disconnect': reply(req); setTimeout(() => process.exit(0), 10); break
    default: reply(req, {}, false, `fixture: unknown ${req.command}`)
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length)
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body.toString()))
  }
})
process.stdin.on('end', () => process.exit(0))
