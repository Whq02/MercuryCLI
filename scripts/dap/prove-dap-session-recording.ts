#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

process.env.NODE_ENV = 'test'
const home = mkdtempSync(path.join(tmpdir(), 'dap-session-recording-home-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const knob of Object.keys(process.env)) if (knob.startsWith('MOCK_MULTI_')) delete process.env[knob]

const RECORDING = path.join(import.meta.dir, 'recordings', 'dap-session.txt')
const RECORDING_NAME = 'scripts/dap/recordings/dap-session.txt'
const SELF = 'scripts/dap/prove-dap-session-recording.ts'
const WRITE = process.argv.includes('--write')
const MOCK = path.join(import.meta.dir, 'mock-dap-adapter-multi.mjs')
const THEN_MOCK = "import(require('node:url').pathToFileURL(process.argv[1]).href)"
const STDERR_THEN_MOCK = `process.stderr.write('recording adapter: warming up\\n'); ${THEN_MOCK}`
const STDOUT_THEN_MOCK = `process.stdout.write('recording adapter: on its port\\n'); ${THEN_MOCK}`
const scratch = mkdtempSync(path.join(tmpdir(), 'dap-session-recording-'))

const { DapSession, createDapSession, removeDapSession, _dapSessionCountForTesting } = await import('../../src/integrations/debugger/dapClient.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
type Session = InstanceType<typeof DapSession>
const owner = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-session-recording', lane: 'main' })

const unhandled: unknown[] = []
process.on('unhandledRejection', reason => unhandled.push(reason))
const spawned: ChildProcess[] = []
const ports: number[] = []
const lines: string[] = []
const NEVER = 'never settled'
let standing = 'before the first scene'

const plain = (text: string): string => ports.reduce((out, port) => out.replaceAll(String(port), '<port>'), text.replaceAll(scratch, '<scratch>'))
const say = (text: string): void => void lines.push(plain(text))
const scene = (title: string): void => {
  standing = title
  lines.push('', `## ${title}`)
}
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const after = <T>(ms: number, value: T): Promise<T> => new Promise(done => setTimeout(() => done(value), ms))
const bounded = <T>(asked: Promise<T>, ms = 15_000): Promise<T | typeof NEVER> => Promise.race([asked, after(ms, NEVER as typeof NEVER)])
const outcome = (asked: Promise<Record<string, unknown>>): Promise<string> =>
  asked.then(body => `answered ${JSON.stringify(body)}`, (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)

async function until(test: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await pause(10)
  return test()
}

function facts(session: Session): string {
  return [
    `label=${session.label}`,
    `depth=${session.depth}`,
    `program=${session.program}`,
    `children=${session.children.length}`,
    `terminated=${session.terminated}`,
    `alive=${session.alive}`,
    `startMode=${session.startMode}`,
    `listener=${JSON.stringify(session.listener)}`,
    `exitDetail=${JSON.stringify(session.exitDetail)}`,
  ].join(' ')
}

function tree(session: Session): string {
  return `tree size=${session.treeSize()} terminated=${session.treeTerminated()} exit=${JSON.stringify(session.treeExitDetail())} end=${JSON.stringify(session.debuggeeEndDetail())}`
}

function sayOutput(session: Session): void {
  for (const line of [...session.output].sort()) say(`output ${line}`)
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      ports.push(port)
      server.close(() => resolve(port))
    })
  })
}

function answers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

async function listening(port: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await answers(port)) return true
    await pause(25)
  }
  return false
}

const bothEnded = (root: Session): boolean => {
  const child = root.children[0]
  return root.children.length === 1 && child !== undefined && root.terminated && child.terminated && root.exitDetail !== '' && child.exitDetail !== ''
}

function sayChild(root: Session): void {
  const child = root.children[0]
  if (child === undefined) return void say('child none')
  say(`child ${facts(child)} parent is the root=${child.parentSession === root} shares the root's output=${child.output === root.output} capabilities=${Object.keys(child.capabilities ?? {}).sort().join(',')}`)
}

function endSpawned(): void {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

function sayDifferences(recorded: string, now: string): void {
  const was = recorded.split('\n')
  const is = now.split('\n')
  let shown = 0
  for (let index = 0; index < Math.max(was.length, is.length) && shown < 20; index++) {
    if (was[index] === is[index]) continue
    shown++
    console.log(`  line ${index + 1}\n    recorded: ${was[index] ?? '(none)'}\n    now:      ${is[index] ?? '(none)'}`)
  }
}

const recorded = existsSync(RECORDING) ? readFileSync(RECORDING, 'utf8') : ''
const watchdog = setTimeout(() => {
  endSpawned()
  const sofar = `${lines.join('\n').trimStart()}\n`
  sayDifferences(recorded.split('\n').slice(0, sofar.split('\n').length - 1).join('\n') + '\n', sofar)
  console.log(`  [FAIL] the scene "${standing}" did not come to its end within 120 s: a step of DapSession it waits for never settles; the ${lines.length} lines before it are compared above with ${RECORDING_NAME}`)
  console.log('prove-dap-session-recording: 1 FAILURE')
  process.exit(1)
}, 120_000)

try {
  scene('a dial with no port ends at once and leaves no rejection unhandled')
  {
    const session = new DapSession('recording', { command: process.execPath, args: [MOCK] }, '/tmp/demo.js', scratch, undefined, 'dial')
    await pause(25)
    say(`unhandled rejections=${unhandled.length}`)
    say(facts(session))
    say(tree(session))
    say(`request threads -> ${await bounded(outcome(session.request('threads')))}`)
    say(`request disconnect -> ${await bounded(outcome(session.request('disconnect')))}`)
    say(`pending=${session._pendingRequestCountForTesting()} waiters=${session._stateWaiterCountForTesting()}`)
    say(`wait for a stop -> ${JSON.stringify(await bounded(session.waitForStopOutcome(50)))}`)
    if ((await bounded(session.dispose())) === NEVER) say(`dispose ${NEVER}`)
    say(`after dispose: ${facts(session)}`)
  }

  scene('a listening program is attached over the dialed socket, and the child it starts dials the same listener')
  {
    const port = await freePort()
    const program = spawn(process.execPath, [MOCK, String(port), '127.0.0.1'], { stdio: 'ignore' })
    spawned.push(program)
    const exited = new Promise<string>(done => program.once('exit', (code, signal) => done(signal ?? `code ${code}`)))
    say(`the program listens=${await listening(port)}`)
    const root = await createDapSession({
      owner,
      id: 'listener',
      adapterKey: 'recording',
      program: `port:${port}`,
      cwd: scratch,
      mode: 'attach',
      port,
      host: '127.0.0.1',
      specOverride: { command: process.execPath, args: ['-e', 'process.exit(9)'], attachShape: 'connect' },
    })
    say(`both ended=${await until(() => bothEnded(root))}`)
    say(`root ${facts(root)}`)
    sayChild(root)
    say(tree(root))
    say(`wait for a stop -> ${JSON.stringify(await bounded(root.waitForStopOutcome(1_000)))}`)
    sayOutput(root)
    say(`removed=${await bounded(removeDapSession(owner, 'listener'))} sessions=${_dapSessionCountForTesting()}`)
    say(`the program left with ${await Promise.race([exited, after(5_000, 'no exit')])}`)
  }

  scene('an adapter that speaks tcp but was given no port: its child is refused, and its stderr is kept')
  {
    const session = new DapSession(
      'recording',
      { command: process.execPath, args: ['-e', STDERR_THEN_MOCK, MOCK], connect: 'tcp' },
      '/tmp/demo.js',
      scratch,
      undefined,
      'spawn',
      { parent: null, label: 'tcp-no-port' },
    )
    await session.withOperation(undefined, () => session.launch({ program: '/tmp/demo.js' }))
    const told = await until(() => session.output.some(line => line.includes('startDebugging#1')) && session.output.some(line => line.startsWith('[adapter] ')))
    say(`the adapter was answered=${told}`)
    say(facts(session))
    say(tree(session))
    sayOutput(session)
    if ((await bounded(session.dispose())) === NEVER) say(`dispose ${NEVER}`)
    say(`after dispose: terminated=${session.terminated} alive=${session.alive} pending=${session._pendingRequestCountForTesting()}`)
  }

  scene('killSync while a terminal process lives, a request waits and a waiter is parked')
  {
    let terminal: ChildProcess | null = null
    process.env.MOCK_MULTI_RUNINTERMINAL = '1'
    const root = await createDapSession({
      owner,
      id: 'terminal',
      adapterKey: 'recording',
      program: '/tmp/demo.js',
      cwd: scratch,
      specOverride: { command: process.execPath, args: [MOCK] },
      terminalRunner: async (_request, _signal, adopt) => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
        terminal = child
        spawned.push(child)
        adopt(child)
        return child.pid ?? 0
      },
    })
    delete process.env.MOCK_MULTI_RUNINTERMINAL
    const ready = await until(
      () =>
        root.terminalProcessCount() === 1 &&
        root.children[0]?.terminated === true &&
        root.output.some(line => line.includes('runInTerminal#1')) &&
        root.output.some(line => line.includes('startDebugging#2')) &&
        root.output.some(line => line.includes('mock-child: ran')),
    )
    const lives = terminal as ChildProcess | null
    const killed =
      lives === null
        ? Promise.resolve(false)
        : new Promise<boolean>(done => lives.once('exit', (code, signal) => done(signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0))))
    say(`ready=${ready} terminal processes=${root.terminalProcessCount()}`)
    say(`root ${facts(root)}`)
    say(tree(root))
    sayOutput(root)
    const waiting = outcome(root.request('threads'))
    const parked = root.waitForStopOutcome(5_000)
    say(`before the kill: pending=${root._pendingRequestCountForTesting()} waiters=${root._stateWaiterCountForTesting()}`)
    root.killSync()
    say(`after the kill: ${facts(root)}`)
    say(`after the kill: terminal processes=${root.terminalProcessCount()} pending=${root._pendingRequestCountForTesting()} waiters=${root._stateWaiterCountForTesting()} child terminated=${root.children[0]?.terminated}`)
    say(`the waiting request -> ${await bounded(waiting)}`)
    say(`the parked waiter -> ${JSON.stringify(await bounded(parked))}`)
    say(`the terminal process was killed=${await Promise.race([killed, after(5_000, false)])}`)
    say(`removed=${await bounded(removeDapSession(owner, 'terminal'))} sessions=${_dapSessionCountForTesting()}`)
  }

  scene('an adapter that speaks tcp is started and dialed on its port, and the child it starts dials that port')
  {
    const root = await createDapSession({
      owner,
      id: 'tcp',
      adapterKey: 'recording',
      program: '/tmp/demo.js',
      cwd: scratch,
      specOverride: { command: process.execPath, args: ['-e', STDOUT_THEN_MOCK, MOCK, '${port}', '127.0.0.1'], connect: 'tcp' },
    })
    say(`both ended=${await until(() => bothEnded(root))}`)
    say(`root ${facts(root)}`)
    sayChild(root)
    say(tree(root))
    sayOutput(root)
    say(`removed=${await bounded(removeDapSession(owner, 'tcp'))} sessions=${_dapSessionCountForTesting()}`)
  }

  await pause(25)
  scene('the whole run')
  say(`unhandled rejections=${unhandled.length}`)
} finally {
  clearTimeout(watchdog)
  endSpawned()
  for (const folder of [scratch, home]) {
    try {
      removeScratch(folder)
    } catch (error) {
      console.log(`  [NOTE] ${folder} was not removed — ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
    }
  }
}

const now = `${lines.join('\n').trimStart()}\n`
if (WRITE) {
  mkdirSync(path.dirname(RECORDING), { recursive: true })
  writeFileSync(RECORDING, now)
  console.log(`prove-dap-session-recording: recorded ${lines.length} lines in ${RECORDING_NAME}`)
  process.exit(0)
}
if (recorded === now) {
  console.log(`  [PASS] DapSession answers the five scenes as recorded (${lines.length} lines equal to ${RECORDING_NAME})`)
  console.log('prove-dap-session-recording: green')
  process.exit(0)
}
sayDifferences(recorded, now)
console.log(`  [FAIL] DapSession no longer answers as recorded in ${RECORDING_NAME}: mend src/integrations/debugger/dapClient.ts or its parts in src/integrations/debugger/client/ until the lines above are equal; only where the difference is meant, record it again with \`bun ${SELF} --write\` and commit the recording`)
console.log('prove-dap-session-recording: 1 FAILURE')
process.exit(1)
