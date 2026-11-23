import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { endProcessTree, registerProcessTreeGuard, runsInAnMsysRuntime, type ProcessTreeKillReceipt } from '../processes/processGroup.js'
import { startTimeout, stopTimeout } from '../async/timers.js'
import { canReraiseOwnSignal, msysSignalExitCode } from '../host-os/processes.js'

const SHELL_PARENT_GUARD = '--tool-shell-parent'
const SHELL_PARENT_GUARD_BUNDLE = 'shell-parent-guard.mjs'

type ShellLaunch = { file: string; args: string[]; detached?: boolean; windowsVerbatimArguments?: boolean }
type GuardMessage = { kind: 'spawned'; pid: number } | { kind: 'spawn-error'; message: string; code?: string } | { kind: 'ended'; receipt: ProcessTreeKillReceipt } | { kind: 'signalled'; status: number; leaves: number }

const MSYS_COUNTS_A_SIGNAL_BY = 256

export function statusAnMsysShellLeaves(status: number, underMsys: boolean, platform: string = process.platform): number {
  return msysSignalExitCode(status, underMsys, platform)
}

let saysWhatTheGuardRead: ((line: string) => void) | undefined

export function tellWhatTheShellGuardReads(say: (line: string) => void): void {
  saysWhatTheGuardRead = say
}

export function shellParentGuardEntry(self: string): string {
  if (!self.endsWith('.mjs')) return fileURLToPath(new URL('../../boot/entrypoints/cli.tsx', import.meta.url))
  const beside = join(dirname(self), SHELL_PARENT_GUARD_BUNDLE)
  return existsSync(beside) ? beside : self
}

let guardEntry: string | undefined

export async function spawnOwnedShell(file: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  guardEntry ??= shellParentGuardEntry(fileURLToPath(import.meta.url))
  const entry = guardEntry
  const launch: ShellLaunch = { file, args, detached: options.detached, windowsVerbatimArguments: options.windowsVerbatimArguments }
  const stdio = Array.isArray(options.stdio) ? options.stdio : ['pipe', 'pipe', 'pipe'] as const
  const guard = spawn(process.execPath, [entry, SHELL_PARENT_GUARD], {
    ...options,
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: false,
    stdio: [...stdio, 'ipc'],
  })
  let receipt: ProcessTreeKillReceipt | null = null
  let ended = false
  guard.on('message', (message: GuardMessage) => {
    if (message.kind === 'ended') receipt = message.receipt
    if (message.kind === 'signalled') saysWhatTheGuardRead?.(`${file} left with status ${message.status}, which is signal ${message.status / MSYS_COUNTS_A_SIGNAL_BY} as the MSYS runtime counts it: the command's exit code reads ${message.leaves}`)
  })
  guard.once('exit', () => { ended = true })
  let stopping: Promise<ProcessTreeKillReceipt | null> | undefined
  registerProcessTreeGuard(guard, signal => {
    if (stopping !== undefined) return stopping
    if (ended) return Promise.resolve(receipt ?? { ended: 0, survivors: [] })
    if (!guard.connected) return Promise.resolve(null)
    stopping = new Promise(resolve => {
      const finish = (): void => { stopTimeout(timer); resolve(receipt) }
      const timer = startTimeout(() => { guard.removeListener('exit', finish); resolve(null) }, 3000)
      guard.once('exit', finish)
      guard.send({ kind: 'stop', signal }, error => { if (error) finish() })
    })
    return stopping
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const exited = (): void => failed(new Error('The shell parent guard ended before starting the command'))
    const message = (value: GuardMessage): void => {
      if (value.kind === 'spawned') {
        Object.defineProperties(guard, { pid: { value: value.pid }, spawnfile: { value: file }, spawnargs: { value: [file, ...args] } })
        guard.kill = signal => {
          if (ended) return false
          void endProcessTree(guard, typeof signal === 'string' ? signal : 'SIGTERM')
          return true
        }
        cleanup()
        resolve()
      }
      if (value.kind === 'spawn-error') failed(Object.assign(new Error(value.message), { code: value.code }))
    }
    const cleanup = (): void => {
      guard.removeListener('error', failed)
      guard.removeListener('exit', exited)
      guard.removeListener('message', message)
    }
    guard.once('error', failed)
    guard.once('exit', exited)
    guard.on('message', message)
    guard.send({ kind: 'launch', launch }, error => { if (error) failed(error) })
  })
  return guard
}

export async function runShellParentGuard(): Promise<void> {
  if (!process.connected || process.send === undefined) {
    process.exitCode = 2
    return
  }
  let child: ChildProcess | undefined
  let ending = false
  const exitLikeChild = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (signal !== null && canReraiseOwnSignal()) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1))
  }
  const end = async (signal: NodeJS.Signals = 'SIGKILL'): Promise<void> => {
    if (ending) return
    ending = true
    const receipt = child !== undefined ? await endProcessTree(child, signal) : { ended: 0, survivors: [] }
    const exit = (): void => exitLikeChild(null, signal)
    if (process.connected) process.send!({ kind: 'ended', receipt }, exit)
    else exit()
  }
  process.once('disconnect', () => { void end() })
  process.on('message', (message: { kind?: string; signal?: NodeJS.Signals }) => {
    if (message.kind === 'stop') void end(message.signal)
  })
  const launch = await new Promise<ShellLaunch>(resolve => {
    process.once('message', (message: { kind: string; launch: ShellLaunch }) => resolve(message.launch))
  })
  const failed = (error: Error): void => {
    if (process.connected) process.send!({ kind: 'spawn-error', message: error.message, code: (error as NodeJS.ErrnoException).code }, () => process.exit(1))
    else process.exit(1)
  }
  try {
    child = spawn(launch.file, launch.args, {
      stdio: [0, 1, 2],
      detached: launch.detached,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    })
  } catch (error) {
    failed(error instanceof Error ? error : new Error(String(error)))
    return
  }
  let spawnSent = Promise.resolve()
  child.once('spawn', () => {
    if (process.connected) spawnSent = new Promise(resolve => process.send!({ kind: 'spawned', pid: child!.pid }, () => resolve()))
  })
  child.once('error', failed)
  child.once('exit', (code, signal) => {
    if (ending) return
    void spawnSent.then(() => {
      const leaves = code === null ? null : statusAnMsysShellLeaves(code, runsInAnMsysRuntime(launch.file))
      if (code === null || leaves === null || leaves === code || !process.connected) {
        exitLikeChild(leaves, signal)
        return
      }
      process.send!({ kind: 'signalled', status: code, leaves }, () => exitLikeChild(leaves, signal))
    })
  })
  if (!process.connected) await end()
}
