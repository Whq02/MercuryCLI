#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-listen-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${title}`)

const scratch = mkdtempSync(path.join(tmpdir(), 'dap-listen-'))
const marker = path.join(scratch, 'stub-started')
const stubAdapter = path.join(scratch, 'stub-adapter.cjs')
writeFileSync(
  stubAdapter,
  [
    'require("fs").writeFileSync(process.argv[2], String(process.pid))',
    'let buffer = Buffer.alloc(0)',
    'let seq = 1',
    'process.stdin.on("data", chunk => {',
    '  buffer = Buffer.concat([buffer, chunk])',
    '  for (;;) {',
    '    const end = buffer.indexOf("\\r\\n\\r\\n")',
    '    if (end < 0) return',
    '    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1])',
    '    if (buffer.length < end + 4 + length) return',
    '    const frame = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())',
    '    buffer = buffer.subarray(end + 4 + length)',
    '    if (frame.type === "request" && frame.command === "initialize") {',
    '      const body = JSON.stringify({ seq: seq++, type: "response", request_seq: frame.seq, success: true, command: "initialize", body: { supportsConfigurationDoneRequest: true } })',
    '      process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)',
    '    }',
    '  }',
    '})',
    'setInterval(() => {}, 1000)',
  ].join('\n'),
)
const adaptersFile = path.join(scratch, 'dap-adapters.json')
writeFileSync(
  adaptersFile,
  JSON.stringify({
    listenstub: {
      command: process.execPath,
      args: [stubAdapter, marker],
      attachShape: 'connect',
      fileTypes: ['.lsn'],
    },
  }),
)
process.env.MERCURY_DAP_ADAPTERS_FILE = adaptersFile

const dapClient = await import('../../src/services/dap/dapClient.ts')
const { createDapSession, removeDapSession } = dapClient
const listenerAttachTarget: typeof dapClient.listenerAttachTarget = (dapClient as Partial<typeof dapClient>).listenerAttachTarget ?? (() => null)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const owner = processMainOwner()

type Frame = Record<string, unknown>

function mockListener(): Promise<{ server: Server; port: number; connections: number; frames: Frame[]; close(): Promise<void> }> {
  const state = { connections: 0, frames: [] as Frame[] }
  const server = createServer((socket: Socket) => {
    state.connections++
    let buffer = Buffer.alloc(0)
    let seq = 1
    const send = (message: Frame): void => {
      const body = JSON.stringify({ seq: seq++, ...message })
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }
    const respond = (request: Frame, body: Frame = {}): void =>
      send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())?.[1] ?? NaN)
        if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return
        const frame = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()) as Frame
        buffer = buffer.subarray(headerEnd + 4 + length)
        state.frames.push(frame)
        if (frame.type !== 'request') continue
        switch (frame.command) {
          case 'initialize':
            respond(frame, { supportsConfigurationDoneRequest: true, supportTerminateDebuggee: true })
            break
          case 'attach':
            send({ type: 'event', event: 'initialized', body: {} })
            respond(frame)
            break
          case 'threads':
            respond(frame, { threads: [{ id: 1, name: 'MainThread' }] })
            break
          default:
            respond(frame)
        }
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        server,
        port,
        get connections() {
          return state.connections
        },
        frames: state.frames,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function attachOutcome(adapterKey: string, port: number, id: string): Promise<{ error: string | null; ms: number; session: Awaited<ReturnType<typeof createDapSession>> | null }> {
  const started = Date.now()
  try {
    const session = await createDapSession({ owner, id, adapterKey, program: `port:${port}`, cwd: scratch, mode: 'attach', port, host: '127.0.0.1' })
    return { error: null, ms: Date.now() - started, session }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - started, session: null }
  }
}

section('§0 the attach target law (pure)')
check('a connect-shaped adapter with a port names the listener', JSON.stringify(listenerAttachTarget({ attachShape: 'connect' }, { mode: 'attach', port: 5679 })) === JSON.stringify({ host: '127.0.0.1', port: 5679 }))
check('the host rides when given', listenerAttachTarget({ attachShape: 'connect' }, { mode: 'attach', port: 5679, host: '::1' })?.host === '::1')
check('a launch names no listener', listenerAttachTarget({ attachShape: 'connect' }, { mode: 'launch', port: 5679 }) === null)
check('an attach by pid names no listener', listenerAttachTarget({ attachShape: 'connect' }, { mode: 'attach' }) === null)
check('a flat-shaped adapter dials nothing (its port is the debuggee agent the adapter connects to)', listenerAttachTarget({ attachShape: 'flat' }, { mode: 'attach', port: 9229 }) === null)
check('a bespoke attach builder keeps its own road', listenerAttachTarget({ attachShape: 'connect', buildAttachArgs: () => ({}) }, { mode: 'attach', port: 5679 }) === null)

section('§1 a listening program is dialed; the adapter of our own is never started')
{
  const listener = await mockListener()
  const outcome = await attachOutcome('listenstub', listener.port, 'listen-1')
  check('the attach succeeds against the listener', outcome.error === null, outcome.error ?? `${outcome.ms}ms`)
  check(`the attach lands well inside the old 10 s silence (${outcome.ms}ms)`, outcome.ms < 5_000)
  check('the stub adapter was never started', !existsSync(marker))
  check('the listener saw exactly one client connection', listener.connections === 1, String(listener.connections))
  const attach = listener.frames.find(f => f.command === 'attach')
  check('the attach request carried the debugpy connect spelling', JSON.stringify((attach?.arguments as Frame | undefined)?.connect) === JSON.stringify({ host: '127.0.0.1', port: listener.port }), JSON.stringify(attach?.arguments))
  check('the session names the listener it dialed', JSON.stringify(outcome.session?.listener) === JSON.stringify({ host: '127.0.0.1', port: listener.port }))
  check('the session reads attached and alive', outcome.session?.startMode === 'attach' && outcome.session.alive === true)
  const threads = await outcome.session?.request('threads').catch(e => ({ error: String(e) }))
  check('a request rides the dialed wire', Array.isArray((threads as Frame | undefined)?.threads))
  await removeDapSession(owner, 'listen-1')
  check('the detach sends disconnect without ending the program (terminateDebuggee false)', listener.frames.some(f => f.command === 'disconnect' && (f.arguments as Frame | undefined)?.terminateDebuggee === false), JSON.stringify(listener.frames.filter(f => f.command === 'disconnect').map(f => f.arguments)))
  const again = await attachOutcome('listenstub', listener.port, 'listen-2')
  check('the listener still takes a second attach after the detach', again.error === null && listener.connections === 2, again.error ?? String(listener.connections))
  await removeDapSession(owner, 'listen-2')
  await listener.close()
}

section('§2 nothing listens at the port: the attach refuses at once in one plain line — no adapter of our own is started to wait for a program that will never come')
{
  const port = await freePort()
  const outcome = await attachOutcome('listenstub', port, 'refused')
  check('the attach refuses', outcome.error !== null)
  check(`the refusal lands at once (${outcome.ms}ms), not after a 10 s silence`, outcome.ms < 2_000)
  check('no adapter of our own was started', !existsSync(marker))
  check(`the line names the dial: nothing is listening at 127.0.0.1:${port} (ECONNREFUSED)`, new RegExp(`^nothing is listening at 127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)`).test(outcome.error ?? ''), (outcome.error ?? '').slice(0, 200))
  check('…and says what to do: start the program with its debug listener on that port first, then attach again', /start the program with its debug listener on 127\.0\.0\.1:\d+ first, then attach again$/.test(outcome.error ?? ''), (outcome.error ?? '').slice(0, 220))
  const pythonLine = (await import('../../src/services/dap/dapClient.ts')).listenerRefusedLine?.({ host: '127.0.0.1', port: 5679 }, 'ECONNREFUSED', 'python')
  check('for the python row the line carries the debugpy start command', pythonLine === 'nothing is listening at 127.0.0.1:5679 (ECONNREFUSED) — start the program with its listener first — python -m debugpy --listen 127.0.0.1:5679 --wait-for-client <script> — then attach again', pythonLine ?? 'undefined')
  rmSync(marker, { force: true })
}

section('§3 a port held by a program that is not a DAP listener')
{
  const silent = createServer((socket: Socket) => socket.on('error', () => undefined))
  const port = await new Promise<number>(resolve =>
    silent.listen(0, '127.0.0.1', () => {
      const address = silent.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )
  const outcome = await attachOutcome('listenstub', port, 'silent')
  check('the attach fails', outcome.error !== null)
  check('the failure names the listening program and the question to ask of it', /the program listening at 127\.0\.0\.1:\d+ did not answer initialize within \d+ms — is it a debugpy --listen socket\?/.test(outcome.error ?? ''), (outcome.error ?? '').slice(0, 200))
  check(`the verdict lands inside the request window (${outcome.ms}ms)`, outcome.ms < 10_000)
  check('no adapter of our own was started for a port that is taken', !existsSync(marker))
  await new Promise<void>(done => silent.close(() => done()))

  const hangsUp = createServer((socket: Socket) => socket.destroy())
  const port2 = await new Promise<number>(resolve =>
    hangsUp.listen(0, '127.0.0.1', () => {
      const address = hangsUp.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )
  const closed = await attachOutcome('listenstub', port2, 'hangs-up')
  check('a program that hangs up is named at once', /the program listening at 127\.0\.0\.1:\d+ closed the connection/.test(closed.error ?? ''), (closed.error ?? '').slice(0, 200))
  check(`…without waiting out a timer (${closed.ms}ms)`, closed.ms < 4_000)
  await new Promise<void>(done => hangsUp.close(() => done()))
}

section('§4 the live leg — a real debugpy --listen program through the vendored tree')
{
  const repo = path.resolve(import.meta.dir, '../..')
  const vendorRoot = [process.env.MERCURY_DEBUGPY_VENDOR_DIR, path.join(repo, 'vendor', 'debugpy', 'extracted'), path.join(repo, 'dist', 'vendor', 'debugpy')]
    .filter((root): root is string => typeof root === 'string' && root !== '' && existsSync(path.join(root, 'debugpy', 'adapter', '__main__.py')))[0]
  const interpreter = ['python3', 'python'].find(candidate => {
    if (vendorRoot === undefined) return false
    const probe = spawnSync(candidate, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(vendorRoot)}); import debugpy; print(debugpy.__version__)`], { encoding: 'utf8', timeout: 20_000 })
    return probe.status === 0
  })
  if (vendorRoot === undefined || interpreter === undefined) {
    console.log(`  [SKIP] no interpreter can import the vendored debugpy here (vendor root: ${vendorRoot ?? 'absent'}; tried python3, python) — the live leg needs one`)
  } else {
    process.env.MERCURY_DEBUGPY_VENDOR_DIR = vendorRoot
    const { _resetDebugpyResolverForTesting } = await import('../../src/services/dap/debugpyResolver.ts')
    _resetDebugpyResolverForTesting()
    const program = path.join(scratch, 'waits.py')
    writeFileSync(program, 'import time\nn = 0\nwhile True:\n    n += 1\n    time.sleep(0.05)\n')
    const port = await freePort()
    let debuggee: ChildProcess | null = spawn(interpreter, ['-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client', program], {
      cwd: scratch,
      env: { ...process.env, PYTHONPATH: vendorRoot, PYDEVD_DISABLE_FILE_VALIDATION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const debuggeeOutput: string[] = []
    debuggee.stdout?.on('data', (chunk: Buffer) => debuggeeOutput.push(String(chunk)))
    debuggee.stderr?.on('data', (chunk: Buffer) => debuggeeOutput.push(String(chunk)))
    const listening = await (async () => {
      const until = Date.now() + 60_000
      while (Date.now() < until) {
        if (debuggee!.exitCode !== null) return false
        const probe = spawnSync(process.execPath, ['-e', `require("net").connect(${port}, "127.0.0.1").on("connect", function(){ this.destroy(); process.exit(0) }).on("error", () => process.exit(1))`], { timeout: 5_000 })
        if (probe.status === 0) return true
        await new Promise(r => setTimeout(r, 250))
      }
      return false
    })()
    check(`debugpy ${interpreter} listens on 127.0.0.1:${port} (--wait-for-client)`, listening, debuggeeOutput.join('').slice(-300))
    if (listening) {
      const outcome = await attachOutcome('python', port, 'live')
      check('the python adapter row attaches to the listening program', outcome.error === null, outcome.error ?? `${outcome.ms}ms`)
      check(`…inside the old 10 s silence (${outcome.ms}ms)`, outcome.ms < 10_000)
      const threads = (await outcome.session?.request('threads').catch(e => ({ error: String(e) }))) as Frame | undefined
      check('the attached program answers threads', Array.isArray(threads?.threads) && (threads!.threads as unknown[]).length > 0, JSON.stringify(threads).slice(0, 160))
      check('the session names the listener', outcome.session?.listener?.port === port)
      await removeDapSession(owner, 'live')
      await new Promise(r => setTimeout(r, 500))
      check('the program survives the detach (an attached program is left running)', debuggee.exitCode === null)
      const again = await attachOutcome('python', port, 'live-2')
      check('a second attach to the same listener works', again.error === null, again.error ?? '')
      await removeDapSession(owner, 'live-2')
    }
    if (debuggee.exitCode === null) {
      debuggee.kill('SIGKILL')
      await new Promise<void>(done => debuggee!.once('exit', () => done()))
    }
    debuggee = null
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-dap-attach-listen-socket: all green' : `prove-dap-attach-listen-socket: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
