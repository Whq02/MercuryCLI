import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

const STREAM_GONE_CODES = new Set(['EPIPE', 'EIO', 'ENXIO', 'EBADF'])

const PEER_GONE_WRITE_CODES = new Set([
  ...STREAM_GONE_CODES,
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
])

export function isPeerGoneWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && PEER_GONE_WRITE_CODES.has(code)
}

function handleStreamGoneErrors(stream: NodeJS.WriteStream | NodeJS.ReadStream, onGone?: (code: string) => void, onHandoverFault?: (code: string, syscall: string) => void): void {
  return notBuilt('src/utils/process.ts:17')
}

export function registerProcessOutputErrorHandlers(): void {
  return notBuilt('src/utils/process.ts:36')
}

const CONSOLE_HANDBACK_GRACE_MS = 5000
let consoleLentDepth = 0
let consoleReturnedAt = 0

export function markConsoleLent(): void {
  consoleLentDepth += 1
}

export function markConsoleReturned(): void {
  consoleLentDepth = Math.max(0, consoleLentDepth - 1)
  consoleReturnedAt = Date.now()
}

function consoleLentOrJustReturned(now: number = Date.now()): boolean {
  return consoleLentDepth > 0 || (consoleReturnedAt > 0 && now - consoleReturnedAt < CONSOLE_HANDBACK_GRACE_MS)
}

type StdinRecovery = (code: string, syscall: string) => void
let stdinRecovery: StdinRecovery | null = null

export function setStdinRecovery(recovery: StdinRecovery | null): void {
  stdinRecovery = recovery
}

export function registerProcessInputErrorHandler(onGone: (code: string) => void, onHandoverFault: (code: string, syscall: string) => void): void {
  handleStreamGoneErrors(process.stdin, onGone, onHandoverFault)
}

export function writeToStderr(data: string): void {
  return notBuilt('src/utils/process.ts:69')
}
