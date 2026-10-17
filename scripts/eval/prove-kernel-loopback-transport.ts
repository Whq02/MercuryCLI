#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, refusingBridge, section, setup, within } from './lib.js'

const { work } = setup()
const ROOT = join(import.meta.dir, '../..')
const { EvalKernelManager } = await loadEval()
const { primeEvalAvailability, pythonCandidates } = await import('../../src/services/eval/interpreters.js')
const { ensurePyRunner } = await import('../../src/services/eval/runnerCache.js')
const { buildKernelEnv } = await import('../../src/services/eval/kernelEnv.js')
const { encodeHostFrame } = await import('../../src/services/eval/protocol.js')
const { kernelTransportFor, ProcKernel } = await import('../../src/services/eval/procKernel.js')
const KERNEL_PROTOCOL_PORT_ENV = 'MERCURY_EVAL_PROTOCOL_PORT'

section('§1 — the transport choice: the Python kernel rides the loopback port on win32 and fd 3 everywhere else; JavaScript keeps fd 3')
check('py on win32 → loopback', kernelTransportFor('py', 'win32') === 'loopback')
check('py on darwin → fd', kernelTransportFor('py', 'darwin') === 'fd')
check('py on linux → fd', kernelTransportFor('py', 'linux') === 'fd')
check('js on win32 → fd', kernelTransportFor('js', 'win32') === 'fd')
check('the runner reads the port from the kernel marker\'s sibling variable', readFileSync(join(ROOT, 'src/services/eval/pyRunnerSource.ts'), 'utf8').includes('os.environ.get("MERCURY_EVAL_PROTOCOL_PORT")') && readFileSync(join(ROOT, 'src/services/eval/procKernel.ts'), 'utf8').includes("'MERCURY_EVAL_PROTOCOL_PORT'"))

section('§2 — the ladder: Windows is no longer refused before the first probe, and its PATH rungs are python3, python, py')
const win = pythonCandidates(work, { PATH: '' }, 'win32')
const mac = pythonCandidates(work, { PATH: '' }, 'darwin')
check('the win32 ladder ends python3, python, py', win.slice(-3).join(' ') === 'python3 python py', win.join(' '))
check('the darwin ladder is unchanged: python3 last and alone', mac.at(-1) === 'python3' && !mac.includes('python') && !mac.includes('py'), mac.join(' '))
const interpretersSource = readFileSync(join(ROOT, 'src/services/eval/interpreters.ts'), 'utf8')
check('no platform refusal stands in discoverPython', !/POSIX-only|Windows packet/.test(interpretersSource) && !/discoverPython[\s\S]{0,200}platform === 'win32'/.test(interpretersSource))
const python = (await primeEvalAvailability(work)).find(row => row.language === 'py')!
check('this box has a Python 3.10+ for the journeys below', python.available === true, JSON.stringify(python))
if (!python.available || python.interpreterPath === undefined) {
  cleanup()
  finish('kernel loopback transport')
}
const interpreter = python.interpreterPath!
const runner = ensurePyRunner()

section('§3 — the protocol byte for byte: the same cells over fd 3 and over the loopback port write the same frames and the same data bytes')
const TOKEN = 'proof-token-0123456789abcdef'
const CELLS = [
  { id: 'c1', code: 'x = 6 * 7\nx' },
  { id: 'c2', code: 'print("out line")\nimport sys\nsys.stderr.write("err line\\n")\nx + 1' },
  { id: 'c3', code: 'raise ValueError("boom")' },
  { id: 'c4', code: 'display_markdown("# a heading")\nlen(str(x))' },
]
type Capture = { protocol: string; stdout: string; stderr: string; code: number | null }
function hostFrames(): string[] {
  const frames: string[] = [encodeHostFrame({ t: 'hello', token: TOKEN, cwd: work })]
  CELLS.forEach((cell, index) => frames.push(encodeHostFrame({ t: 'exec', id: cell.id, code: cell.code, seq: index + 1 })))
  frames.push(encodeHostFrame({ t: 'bye' }))
  return frames
}
async function drive(child: ChildProcess, protocolBytes: () => string, ready: Promise<void>): Promise<Capture> {
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => { stdout += chunk })
  child.stderr!.on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  await ready
  const frames = hostFrames()
  child.stdin!.write(frames[0]!)
  for (const frame of frames.slice(1, -1)) {
    const before = protocolBytes()
    child.stdin!.write(frame)
    await within('a cell settles', 20_000, new Promise<void>(resolve => {
      const tick = setInterval(() => {
        if (protocolBytes().slice(before.length).includes('"t": "done"')) { clearInterval(tick); resolve() }
      }, 10)
    }))
  }
  child.stdin!.write(frames.at(-1)!)
  const code = await within('the runner leaves on bye', 10_000, exited)
  await new Promise(resolve => setTimeout(resolve, 100))
  return { protocol: protocolBytes(), stdout, stderr, code }
}
async function overFd3(): Promise<Capture> {
  const child = spawn(interpreter, [runner], { cwd: work, env: buildKernelEnv(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  let protocol = ''
  const stream = child.stdio[3] as NodeJS.ReadableStream
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => { protocol += chunk })
  return drive(child, () => protocol, Promise.resolve())
}
async function overLoopback(): Promise<Capture & { connections: number; server: Server }> {
  let protocol = ''
  let connections = 0
  const server = createServer(socket => {
    connections++
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { protocol += chunk })
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
  const connected = new Promise<void>(resolve => server.once('connection', () => resolve()))
  const child = spawn(interpreter, [runner], { cwd: work, env: { ...buildKernelEnv(), [KERNEL_PROTOCOL_PORT_ENV]: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] })
  const capture = await drive(child, () => protocol, within('the runner connects to the port', 15_000, connected))
  server.close()
  return { ...capture, connections, server }
}
const viaFd = await overFd3()
const viaPort = await overLoopback()
check('the fd-3 road answered every cell (the control)', (viaFd.protocol.match(/"t": "done"/g) ?? []).length === CELLS.length && viaFd.code === 0, `${viaFd.protocol.length} bytes, exit ${viaFd.code}`)
check('the loopback road answered every cell over one connection', (viaPort.protocol.match(/"t": "done"/g) ?? []).length === CELLS.length && viaPort.code === 0 && viaPort.connections === 1, `${viaPort.protocol.length} bytes, exit ${viaPort.code}, ${viaPort.connections} connection(s)`)
check('the protocol bytes are identical on both roads', viaFd.protocol === viaPort.protocol, `fd3 ${viaFd.protocol.length} bytes vs port ${viaPort.protocol.length} bytes`)
check('the stdout bytes (user output and end marks) are identical', viaFd.stdout === viaPort.stdout, JSON.stringify([viaFd.stdout.slice(0, 120), viaPort.stdout.slice(0, 120)]))
check('the stderr bytes are identical', viaFd.stderr === viaPort.stderr, JSON.stringify([viaFd.stderr.slice(0, 120), viaPort.stderr.slice(0, 120)]))
check('the frames carry the result, the error and the display', viaPort.protocol.includes('"repr": "42"') && viaPort.protocol.includes('"name": "ValueError"') && viaPort.protocol.includes('"t": "display"'), viaPort.protocol.slice(0, 300))
check('every frame carries the hello token', viaPort.protocol.split('\n').filter(Boolean).every(line => line.includes(`"token": "${TOKEN}"`)))

function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}
const PORT_CELL = 'import os\nint(os.environ["MERCURY_EVAL_PROTOCOL_PORT"])'
const CHANNEL_CELL = 'import sys\ntype(sys.modules["__main__"]._PROTO.buffer.raw).__name__'

section('§4 — the whole road forced on the Mac: a manager whose Python kernel rides the loopback port runs cells, keeps state, reports errors, serves the bridge and survives an interrupt')
const forced = new EvalKernelManager({ idleTtlMs: 600_000, idleSweepMs: 60_000, pyTransport: 'loopback' })
const control = new EvalKernelManager({ idleTtlMs: 600_000, idleSweepMs: 60_000 })
const bridge = refusingBridge()
const run = (manager: InstanceType<typeof EvalKernelManager>, code: string, extra: Partial<{ timeoutSeconds: number }> = {}) =>
  within(`py cell`, 60_000, manager.runCell({ owner: 'loopback-owner', cwd: work, input: { language: 'py', code, ...extra }, abortSignal: new AbortController().signal, serveBridge: bridge }))
try {
  const seed = await run(forced, 'import os\nkept = 7\n"port" if os.environ.get("MERCURY_EVAL_PROTOCOL_PORT") else "fd"')
  check('the forced kernel was born with the port named', seed.status === 'ok' && seed.resultRepr === "'port'", JSON.stringify({ status: seed.status, repr: seed.resultRepr, error: seed.error }))
  const channel = await run(forced, CHANNEL_CELL)
  check('the forced kernel speaks over a socket, not a pipe', channel.status === 'ok' && channel.resultRepr === "'SocketIO'", JSON.stringify({ status: channel.status, repr: channel.resultRepr }))
  const portCell = await run(forced, PORT_CELL)
  const forcedPort = Number(portCell.resultRepr)
  check('the host listens on the port it named while the kernel lives', Number.isInteger(forcedPort) && (await canConnect(forcedPort)), JSON.stringify({ status: portCell.status, repr: portCell.resultRepr }))
  const state = await run(forced, 'kept + 1')
  check('state persists across cells on the loopback road', state.status === 'ok' && state.resultRepr === '8', JSON.stringify({ status: state.status, repr: state.resultRepr }))
  const streams = await run(forced, 'print("hello out")\nimport sys\nsys.stderr.write("hello err\\n")')
  check('stdout and stderr arrive and settle with the cell', streams.status === 'ok' && streams.stdout.text.trim() === 'hello out' && streams.stderr.text.trim() === 'hello err', JSON.stringify({ out: streams.stdout.text, err: streams.stderr.text }))
  const failed = await run(forced, 'raise KeyError("nope")')
  check('an error cell reports its traceback', failed.status === 'error' && failed.error?.name === 'KeyError', JSON.stringify(failed.error))
  const bridged = await run(forced, 'tool.attempt("Read", file_path="x.txt")')
  check('a bridge call travels the loopback road out and the stdin road back', bridged.status === 'ok' && (bridged.resultRepr ?? '').includes("'ok': False") && (bridged.resultRepr ?? '').includes('no bridge in this prover'), JSON.stringify({ status: bridged.status, repr: bridged.resultRepr, error: bridged.error }))
  const cancelled = await run(forced, 'import time\nwhile True:\n    time.sleep(0.05)\n', { timeoutSeconds: 1 })
  check('the runtime budget interrupts the cell', cancelled.status === 'cancelled', cancelled.status)
  const survived = await run(forced, 'kept')
  check('the kernel and its state survive the interrupt', survived.status === 'ok' && survived.resultRepr === '7', JSON.stringify({ status: survived.status, repr: survived.resultRepr }))
  const controlSeed = await run(control, 'import os\n"port" if os.environ.get("MERCURY_EVAL_PROTOCOL_PORT") else "fd"')
  check('the control manager on this Mac keeps the fd-3 road', controlSeed.status === 'ok' && controlSeed.resultRepr === "'fd'", JSON.stringify({ status: controlSeed.status, repr: controlSeed.resultRepr }))
  const controlChannel = await run(control, CHANNEL_CELL)
  check('the control kernel speaks over the fd-3 pipe', controlChannel.status === 'ok' && controlChannel.resultRepr === "'FileIO'", JSON.stringify({ status: controlChannel.status, repr: controlChannel.resultRepr }))

  section('§5 — a kernel that dies mid-cell on the loopback road ends the cell honestly, and its listener closes with it')
  const died = await run(forced, 'import os\nos._exit(3)')
  check('the cell did not hang: the death is reported', died.status !== 'ok' && died.annotations.length > 0, JSON.stringify({ status: died.status, annotations: died.annotations }))
  check('the dead kernel\'s listener is closed', !(await canConnect(forcedPort)))
  const replacedPort = Number((await run(forced, PORT_CELL)).resultRepr)
  check('the replacement kernel listens on a port of its own', Number.isInteger(replacedPort) && replacedPort !== forcedPort && (await canConnect(replacedPort)), String(replacedPort))
  await forced.disposeAll()
  await control.disposeAll()
  check('no loopback listener outlives its kernel', !(await canConnect(replacedPort)))

  section('§6 — ProcKernel.launch with the loopback transport handshakes the real runner; the fd transport is the same constructor as before')
  const direct = await ProcKernel.launch({ command: interpreter, args: [runner], cwd: work, env: buildKernelEnv(), transport: 'loopback' })
  check('the launched kernel names its transport', direct.transport === 'loopback')
  check('the handshake completes over the port', await direct.handshake(work, 15_000))
  await direct.dispose()
  const plain = await ProcKernel.launch({ command: interpreter, args: [runner], cwd: work, env: buildKernelEnv(), transport: 'fd' })
  check('the fd transport handshakes as before', plain.transport === 'fd' && (await plain.handshake(work, 15_000)))
  await plain.dispose()
} finally {
  await forced.disposeAll().catch(() => undefined)
  await control.disposeAll().catch(() => undefined)
  cleanup()
}
finish('kernel loopback transport')
