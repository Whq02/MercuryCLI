import { openSync, constants as fsConstants, readSync, closeSync } from 'node:fs'
import { ReadStream as TtyReadStream } from 'node:tty'
import { logForDebugging } from '../../utils/debug.js'
import { markConsoleLent, markConsoleReturned } from '../../utils/process.js'
import { holdConsoleRead } from '../root/console-read.js'
import type Ink from '../ink.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout } from '../../utils/timers.js'

const STDIN_REARM_DELAY_MS = 50

const STDIN_REARM_ATTEMPTS = 8

function rawModeOn(stdin: NodeJS.ReadStream): boolean {
  return (stdin as { isRaw?: boolean }).isRaw === true
}

export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return
  try {
    while (stdin.read() !== null) {}
  } catch (error) {
    passedOver(error)
  }
  if (process.platform === 'win32') return
  const wasRaw = rawModeOn(stdin)
  let switchedRaw = false
  let fd: number | null = null
  try {
    if (!wasRaw) {
      stdin.setRawMode(true)
      switchedRaw = true
    }
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const buf = Buffer.allocUnsafe(1024)
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break
    }
  } catch (error) {
    passedOver(error)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (error) {
        passedOver(error)
      }
    }
    if (switchedRaw) {
      try {
        stdin.setRawMode(false)
      } catch (error) {
        passedOver(error)
      }
    }
  }
}

export function suspendStdin(this: Pick<Ink, 'options' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld'>): void {
  const { stdin } = this.options
  if (!stdin.isTTY) return
  markConsoleLent()
  const listeners = stdin.listeners('readable') as Array<(...args: unknown[]) => void>
  for (const listener of listeners) stdin.removeListener('readable', listener)
  this.storedReadableListeners = listeners
  const isRaw = rawModeOn(stdin)
  logForDebugging(`suspendStdin: removed ${listeners.length} readable listener(s), raw=${isRaw}`)
  if (isRaw) {
    this.consoleReadHeld = holdConsoleRead(stdin)
    stdin.setRawMode(false)
    this.wasRawMode = true
  }
}

type ResumeStdinReads = Pick<
  Ink,
  | 'options' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld' | 'reconcileSize' | 'reassertScreenState' | 'armScreenWatchdog'
>

export function resumeStdin(this: ResumeStdinReads): void {
  const { stdin } = this.options
  if (!stdin.isTTY) return
  if ((!this.storedReadableListeners || this.storedReadableListeners.length === 0) && !this.wasRawMode) {
    logForDebugging('resumeStdin: nothing stored — possible desync, re-asserting screen state', { level: 'warn' })
    this.reassertScreenState('resume-desync')
  }
  if (this.storedReadableListeners) {
    for (const listener of this.storedReadableListeners) stdin.addListener('readable', listener)
    this.storedReadableListeners = null
  }
  markConsoleReturned()
  if (this.wasRawMode) {
    stdin.setRawMode(true)
    if (this.consoleReadHeld) {
      this.consoleReadHeld = false
      stdin.read(0)
    }
    this.wasRawMode = false
  }
  this.reconcileSize()
  this.armScreenWatchdog()
}

type RecoverStdinReads = Pick<
  Ink,
  | 'options' | 'isTTY' | 'currentTree' | 'isUnmounted' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld' | 'stdinRecoveryArmed' | 'render'
>

export function recoverStdin(this: RecoverStdinReads, code: string, syscall: string): void {
  if (this.isUnmounted || !this.isTTY || this.stdinRecoveryArmed) return
  this.stdinRecoveryArmed = true
  startTimeout(() => rearmStdinAfterFault.call(this, code, syscall, 1), STDIN_REARM_DELAY_MS)
}

type RearmStdinAfterFaultReads = Pick<
  Ink,
  | 'options' | 'currentTree' | 'isUnmounted' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld' | 'stdinRecoveryArmed' | 'render'
>

function rearmStdinAfterFault(this: RearmStdinAfterFaultReads, code: string, syscall: string, attempt: number): void {
  if (this.isUnmounted) {
    this.stdinRecoveryArmed = false
    return
  }
  const label = `stdin recovery after ${syscall} ${code}`
  const { stdin } = this.options
  if (stdin.destroyed) {
    let fresh: NodeJS.ReadStream
    try {
      fresh = new TtyReadStream(0)
    } catch (error) {
      logForDebugging(`${label}: the reader was destroyed and a fresh one could not open the terminal — ${String(error)}`, { level: 'warn' })
      this.stdinRecoveryArmed = false
      return
    }
    this.options.stdin = fresh
    this.storedReadableListeners = null
    this.wasRawMode = false
    this.consoleReadHeld = false
    markConsoleLent()
    try {
      if (this.currentTree !== null) this.render(this.currentTree)
    } finally {
      markConsoleReturned()
    }
    logForDebugging(
      `${label}: the reader was destroyed by the hand-off — a fresh reader on the same terminal takes over (raw=${rawModeOn(fresh)})`,
      { level: 'warn' },
    )
    this.stdinRecoveryArmed = false
    return
  }
  if (!rawModeOn(stdin)) {
    markConsoleLent()
    try {
      stdin.setRawMode(true)
    } finally {
      markConsoleReturned()
    }
    if (!rawModeOn(stdin)) {
      if (attempt < STDIN_REARM_ATTEMPTS) {
        startTimeout(() => rearmStdinAfterFault.call(this, code, syscall, attempt + 1), STDIN_REARM_DELAY_MS)
        return
      }
      logForDebugging(
        `${label}: raw mode could not be re-armed in ${attempt} tries — keys may not arrive until the terminal is re-opened`,
        { level: 'warn' },
      )
      this.stdinRecoveryArmed = false
      return
    }
  }
  logForDebugging(`${label}: input re-armed on try ${attempt} (raw mode on, the session stays)`, { level: 'warn' })
  this.stdinRecoveryArmed = false
}
