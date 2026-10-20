import type { ErrorClass, OutcomeRow } from './rows.js'
import type { RowReadFailure } from './parse.js'
import type { Issue } from './validate.js'

export type RunExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string }
export type Door = 'run' | 'runner'

const stderrLines = (exit: RunExit): string[] => exit.stderr.split('\n').map(line => line.trim()).filter(line => line !== '')

export class MercuryError extends Error {
  override readonly name: string = 'MercuryError'
  code?: number
  data?: unknown
  exit: RunExit | null
  constructor(message: string, exit: RunExit | null, options?: ErrorOptions) {
    super(message, options)
    this.exit = exit
  }
}

export class MercuryRefusal extends MercuryError {
  override readonly name = 'MercuryRefusal'
  readonly outcome: OutcomeRow | null
  readonly errorClass: ErrorClass
  readonly detail: readonly string[]
  constructor(outcome: OutcomeRow | null, exit: RunExit | null, rpc?: { message: string; code: number; data?: unknown }) {
    super(rpc?.message ?? outcome?.error?.message ?? 'The request was refused', exit)
    this.code = rpc?.code
    this.data = rpc?.data
    this.outcome = outcome
    this.errorClass = outcome?.error?.class ?? 'option'
    this.detail = outcome?.error?.detail ?? []
  }
}

export class MercuryUsageError extends MercuryError {
  override readonly name = 'MercuryUsageError'
  readonly door: Door
  constructor(exit: RunExit, door: Door = 'run') {
    super(stderrLines(exit)[0] ?? `mercury ${door} refused the command line (exit 2) and wrote no reason`, exit)
    this.door = door
  }
}

export class MercuryExitError extends MercuryError {
  override readonly name = 'MercuryExitError'
  readonly door: Door
  constructor(exit: RunExit, door: Door = 'run') {
    const why = exit.signal !== null ? `ended by ${exit.signal}` : `exited ${exit.code ?? 'without a code'}`
    const reason = stderrLines(exit).at(-1)
    super(`mercury ${door} ${why} before ${door === 'run' ? 'an outcome row' : 'the session was closed'}${reason !== undefined ? `: ${reason}` : ''}`, exit)
    this.door = door
  }
}

export class MercurySpawnError extends MercuryError {
  override readonly name = 'MercurySpawnError'
  readonly command: string
  constructor(command: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const hint = /ENOENT|not found/i.test(detail) ? ' (install Mercury CLI from https://mercury-cli.ai or pass the executable path in the mercury option)' : ''
    super(`could not start ${JSON.stringify(command)}: ${detail}${hint}`, null, { cause })
    this.command = command
  }
}

export class MercuryWireError extends MercuryError {
  override readonly name = 'MercuryWireError'
  readonly line: string
  readonly reason: RowReadFailure
  readonly rowType: string | undefined
  readonly issues: readonly Issue[]
  constructor(line: string, reason: RowReadFailure, rowType: string | undefined, issues: readonly Issue[], exit: RunExit | null) {
    const detail = issues.length > 0 ? `: ${issues.slice(0, 3).map(issue => `${issue.path || 'row'}: ${issue.message}`).join('; ')}` : ''
    super(`a stdout line is not a row or message the package knows (${reason}${rowType !== undefined ? ` ${rowType}` : ''})${detail}`, exit)
    this.line = line
    this.reason = reason
    this.rowType = rowType
    this.issues = issues
  }
}
