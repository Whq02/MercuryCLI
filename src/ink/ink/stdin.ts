import { openSync, constants as fsConstants, readSync, closeSync } from 'node:fs'
import { ReadStream as TtyReadStream } from 'node:tty'
import { logForDebugging } from '../../utils/debug.js'
import { markConsoleLent, markConsoleReturned } from '../../utils/process.js'
import { holdConsoleRead } from '../root/console-read.js'
import type Ink from '../ink.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

const STDIN_REARM_DELAY_MS = 50

const STDIN_REARM_ATTEMPTS = 8

function rawModeOn(stdin: NodeJS.ReadStream): boolean {
  return (stdin as { isRaw?: boolean }).isRaw === true
}

export function drainStdin(stdin?: NodeJS.ReadStream): void {
  return notBuilt('src/ink/ink/stdin.ts:18')
}

export function suspendStdin(this: Pick<Ink, 'options' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld'>): void {
  return notBuilt('src/ink/ink/stdin.ts:63')
}

type ResumeStdinReads = Pick<
  Ink,
  | 'options' | 'storedReadableListeners' | 'wasRawMode' | 'consoleReadHeld' | 'reconcileSize' | 'reassertScreenState' | 'armScreenWatchdog'
>

export function resumeStdin(this: ResumeStdinReads): void {
  return notBuilt('src/ink/ink/stdin.ts:86')
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
  return notBuilt('src/ink/ink/stdin.ts:131')
}
