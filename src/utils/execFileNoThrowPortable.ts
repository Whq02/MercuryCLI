import { execSync } from 'node:child_process'

import { getCwd } from './cwd.js'
import { slowLogging } from './slowOperations.js'
import { subprocessEnv } from './subprocessEnv.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const ONE_MEGABYTE = 1024 * 1024

type PortableOptions = {
  abortSignal?: AbortSignal
  timeout?: number
}

/**
 * Deprecated synchronous shell execution returning trimmed stdout, or null
 * when stdout is empty or anything throws. Throws only when a pre-aborted
 * signal is passed.
 *
 * @deprecated Prefer the async never-throwing helper.
 */
export function execSyncWithDefaults_DEPRECATED(command: string): string | null
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  options: PortableOptions,
): string | null
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  abortSignal: AbortSignal | undefined,
  timeout?: number,
): string | null
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  optionsOrAbortSignal?: PortableOptions | AbortSignal,
  timeout?: number,
): string | null {
  let abortSignal: AbortSignal | undefined
  let timeoutMs: number | undefined
  if (optionsOrAbortSignal instanceof AbortSignal) {
    abortSignal = optionsOrAbortSignal
    timeoutMs = timeout
  } else if (optionsOrAbortSignal) {
    abortSignal = optionsOrAbortSignal.abortSignal
    timeoutMs = optionsOrAbortSignal.timeout
  }
  if (abortSignal?.aborted) {
    throw new Error('Command aborted before execution')
  }
  const slow = slowLogging`execSyncWithDefaults ${command.slice(0, 200)}`
  try {
    const stdout = execSync(command, {
      windowsHide: true,
      env: subprocessEnv(),
      maxBuffer: ONE_MEGABYTE,
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: getCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    const trimmed = stdout.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  } finally {
    slow[Symbol.dispose]()
  }
}
