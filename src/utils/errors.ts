import { APIUserAbortError } from './api/sdkErrors.js'
import { notBuilt } from '../pi/holes.js'


class MercuryError extends Error {
  constructor(message?: string) {
    notBuilt('src/utils/errors.ts:5')
    super(...(notBuilt('src/utils/errors.ts:5') as ConstructorParameters<typeof Error>))
  }
}

export class MalformedCommandError extends Error {}

export class AbortError extends Error {
  constructor(message?: string) {
    notBuilt('src/utils/errors.ts:14')
    super(...(notBuilt('src/utils/errors.ts:14') as ConstructorParameters<typeof Error>))
  }
}

export class ConfigParseError extends MercuryError {
  constructor(
    message: string,
    readonly filePath: string,
    readonly defaultConfig: unknown,
  ) {
    notBuilt('src/utils/errors.ts:21')
    super(...(notBuilt('src/utils/errors.ts:21') as ConstructorParameters<typeof MercuryError>))
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
  pipelineStatus?: number[]
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number,
    readonly interrupted: boolean,
    readonly ran: boolean = true,
    readonly notice: string = '',
  ) {
    super('Shell command failed')
  }
}

export interface ShellRunFact {
  code: number | null
  output?: string
}

interface ShellCallValue {
  code: number | null
  stdout: string
  stderr: string
}

export function shellCallValue(fact: ShellRunFact, text: string): ShellCallValue {
  return notBuilt('src/utils/errors.ts:69')
}

export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    notBuilt('src/utils/errors.ts:76')
    super(...(notBuilt('src/utils/errors.ts:76') as ConstructorParameters<typeof Error>))
  }
}


export function isAbortError(error: unknown): boolean {
  return notBuilt('src/utils/errors.ts:84')
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return notBuilt('src/utils/errors.ts:90')
}

export function toError(value: unknown): Error {
  return notBuilt('src/utils/errors.ts:94')
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
  return notBuilt('src/utils/errors.ts:117')
}

export function isENOENT(error: unknown): boolean {
  return notBuilt('src/utils/errors.ts:125')
}

export function getErrnoPath(error: unknown): string | undefined {
  return notBuilt('src/utils/errors.ts:129')
}

const FS_INACCESSIBLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])

export function isFsInaccessible(error: unknown): error is NodeJS.ErrnoException {
  const code = getErrnoCode(error)
  return code !== undefined && FS_INACCESSIBLE_CODES.has(code)
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
