/**
 * The product error taxonomy: named error classes plus the errno/abort/HTTP
 * classification helpers used at catch sites estate-wide.
 *
 * Dependency discipline: the SDK's user-abort class arrives through the
 * zero-dependency `services/api/sdkErrors.ts` leaf (never the SDK package —
 * the import fence pins the SDK's importer set), and the HTTP-client
 * classifier inspects the client library's marker property directly so this
 * module stays dependency-free.
 */
import { APIUserAbortError } from '../services/api/sdkErrors.js'

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** The generic product error; subclasses name themselves. */
export class MercuryError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = this.constructor.name
  }
}

/** Extends the plain platform error and sets no name of its own, so it
 *  reports the BASE error name at runtime. */
export class MalformedCommandError extends Error {}

/** The abort class other code matches BY NAME (contract data: `AbortError`). */
export class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

/** A configuration file failed to parse; carries the path and the default. */
export class ConfigParseError extends MercuryError {
  constructor(
    message: string,
    readonly filePath: string,
    readonly defaultConfig: unknown,
  ) {
    super(message)
  }
}

/**
 * A configuration file EXISTS but could not be read — EACCES/EPERM on the
 * file or an ancestor, EBUSY from a sharing violation while another process
 * holds it, EIO, EISDIR. Distinct from ConfigParseError on purpose: the
 * bytes are not known to be bad, so the remedy is never "reset to
 * defaults" (which would overwrite the state the read could not see) —
 * it is to make the file readable and start again. `code` is the errno.
 */
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

/**
 * A shell invocation failed. Callers read the fields, not the message — the
 * message is fixed and independent of them.
 */
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

/** A teleport operation failed; carries a preformatted display message. */
export class TeleportOperationError extends MercuryError {
  constructor(
    message: string,
    readonly formattedMessage: string,
  ) {
    super(message)
  }
}

/**
 * An error whose message the author VERIFIED contains no paths, URLs or code
 * — the long class name is the assertion. The runtime name is the short
 * form. An optional distinct telemetry message defaults to the user message.
 */
export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}

// ---------------------------------------------------------------------------
// Abort detection and normalizers
// ---------------------------------------------------------------------------

/**
 * The three abort shapes: the product's class, the SDK's user-abort class
 * (matched by instance — minified builds mangle class names and the SDK never
 * sets the name property), and anything carrying the abort name.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortError) return true
  if (error instanceof APIUserAbortError) return true
  return error instanceof Error && error.name === 'AbortError'
}

/** Exact-message equality. */
export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

/** Wrap an unknown thrown value into an Error. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

/** Extract a message string from an unknown thrown value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/**
 * The message WITH its cause chain (bounded). Node's fetch wraps every
 * pre-HTTP failure as TypeError 'fetch failed' with the real reason on
 * `cause` (DNS, TLS, connection-refused, dispatcher mismatch) — surfacing
 * only the wrapper turns every distinct network fault into one opaque
 * string.
 */
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

// ---------------------------------------------------------------------------
// Errno helpers
// ---------------------------------------------------------------------------

/** The string `code` property, when present. */
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

/** The string `path` property, when present. */
export function getErrnoPath(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'path' in error) {
    const path = (error as { path?: unknown }).path
    if (typeof path === 'string') return path
  }
  return undefined
}

/** Codes meaning "nothing there / no access" (vs a real fault). */
const FS_INACCESSIBLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])

/** True for filesystem errors that mean the path is simply inaccessible. */
export function isFsInaccessible(error: unknown): error is NodeJS.ErrnoException {
  const code = getErrnoCode(error)
  return code !== undefined && FS_INACCESSIBLE_CODES.has(code)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * A short stack: the header line plus at most `maxFrames` frame lines. Used
 * when an error flows to the model as a tool result, where a full stack
 * wastes context. Non-errors stringify; a stackless error returns its
 * message; a stack already within the limit is returned whole.
 */
export function shortErrorStack(error: unknown, maxFrames: number = 5): string {
  if (!(error instanceof Error)) return String(error)
  if (!error.stack) return error.message
  const lines = error.stack.split('\n')
  if (lines.length <= maxFrames + 1) return error.stack
  return lines.slice(0, maxFrames + 1).join('\n')
}

/**
 * Enrich the platform's invalid-argument-type message with a stack callsite
 * and a note asking for that line to be reported — the raw message names
 * neither the caller nor the origin. Nothing for any other code.
 */
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
  // Prefer the first frame that is not a runtime-internal frame; fall back to
  // the very first.
  const isInternal = (frame: string): boolean =>
    frame.includes('node:internal') || frame.includes('(internal/') || frame.includes('node:path')
  const frame = frames.find(candidate => !isInternal(candidate)) ?? frames[0]
  const location = frame.replace(/^at\s+/, '')
  return `${err.message} ${note} — thrown at ${location}`
}

// ---------------------------------------------------------------------------
// HTTP-client classification
// ---------------------------------------------------------------------------

export type AxiosErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'other'

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND'])

/**
 * Classify an HTTP-client error. Order matters: the STATUS is examined
 * before the error code, so a 401 that also carries a network code
 * classifies as `auth`. The status, when present, is returned on every
 * client-error kind. Detection reads the library's marker property directly
 * (`isAxiosError`) so this module stays dependency-free.
 */
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
