import { APIUserAbortError } from '../services/api/sdkErrors.js'


export class MercuryError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class MalformedCommandError extends Error {}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

export class ConfigParseError extends MercuryError {
  constructor(
    message: string,
    readonly filePath: string,
    readonly defaultConfig: unknown,
  ) {
    super(message)
  }
}

export class ConfigReadError extends MercuryError {
  constructor(
    readonly filePath: string,
    readonly code: string,
    cause: unknown,
  ) {
    super(
      `Mercury configuration file at ${filePath} exists but could not be read (${code}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

export class ShellError extends MercuryError {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number,
    readonly interrupted: boolean,
  ) {
    super('Shell command failed')
  }
}

export class TeleportOperationError extends MercuryError {
  constructor(
    message: string,
    readonly formattedMessage: string,
  ) {
    super(message)
  }
}

export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}


export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortError) return true
  if (error instanceof APIUserAbortError) return true
  return error instanceof Error && error.name === 'AbortError'
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

export function errorMessageWithCause(value: unknown, maxDepth = 3): string {
  const parts: string[] = [errorMessage(value)]
  let cursor: unknown = value
  for (let i = 0; i < maxDepth; i++) {
    const cause: unknown = cursor instanceof Error ? cursor.cause : undefined
    if (cause === undefined || cause === null) break
    parts.push(errorMessage(cause))
    cursor = cause
  }
  return parts.length > 1 ? `${parts[0]} (cause: ${parts.slice(1).join(' ← ')})` : parts[0]!
}


export function getErrnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

export function isENOENT(error: unknown): boolean {
  return getErrnoCode(error) === 'ENOENT'
}

export function getErrnoPath(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'path' in error) {
    const path = (error as { path?: unknown }).path
    if (typeof path === 'string') return path
  }
  return undefined
}

const FS_INACCESSIBLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])

export function isFsInaccessible(error: unknown): error is NodeJS.ErrnoException {
  const code = getErrnoCode(error)
  return code !== undefined && FS_INACCESSIBLE_CODES.has(code)
}


export function shortErrorStack(error: unknown, maxFrames: number = 5): string {
  if (!(error instanceof Error)) return String(error)
  if (!error.stack) return error.message
  const lines = error.stack.split('\n')
  if (lines.length <= maxFrames + 1) return error.stack
  return lines.slice(0, maxFrames + 1).join('\n')
}

export function describeInvalidArgTypeError(error: unknown): string | null {
  if (getErrnoCode(error) !== 'ERR_INVALID_ARG_TYPE') return null
  const err = toError(error)
  const note =
    '[an undefined value reached a typed argument — report this as a Mercury bug]'
  const frames = (err.stack ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
  if (frames.length === 0) return `${err.message} ${note}`
  const isInternal = (frame: string): boolean =>
    frame.includes('node:internal') || frame.includes('(internal/') || frame.includes('node:path')
  const frame = frames.find(candidate => !isInternal(candidate)) ?? frames[0]
  const location = frame.replace(/^at\s+/, '')
  return `${err.message} ${note} — thrown at ${location}`
}


export type AxiosErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'other'

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND'])

export function classifyAxiosError(error: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(error)
  const marker =
    error !== null &&
    typeof error === 'object' &&
    (error as { isAxiosError?: unknown }).isAxiosError === true
  if (!marker) return { kind: 'other', message }
  const status = (error as { response?: { status?: unknown } }).response?.status
  const numericStatus = typeof status === 'number' ? status : undefined
  const withStatus = numericStatus === undefined ? {} : { status: numericStatus }
  if (numericStatus === 401 || numericStatus === 403) {
    return { kind: 'auth', ...withStatus, message }
  }
  const code = getErrnoCode(error)
  if (code === 'ECONNABORTED') return { kind: 'timeout', ...withStatus, message }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return { kind: 'network', ...withStatus, message }
  }
  return { kind: 'http', ...withStatus, message }
}
