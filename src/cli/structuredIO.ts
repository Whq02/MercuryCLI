
import { writeSync } from 'node:fs'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { createRowStamper, type RowDraft } from '../rows/project.js'
import { InputRowSchema, type InputRow, type Row } from '../rows/vocabulary.js'
import { MAX_LINE_BYTES } from '../runner/wire/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { stripBOM } from '../utils/jsonRead.js'
import { Stream } from '../utils/stream.js'

function fatalProtocolError(reason: string): never {
  try {
    writeSync(2, `${reason}\n`)
  } catch {
  }
  process.exit(1)
}

export const BROKEN_STDOUT_LINE =
  "stdout closed before the run's output was delivered (broken pipe) — the undelivered output is lost; the session transcript is intact"

export function isBrokenPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

export const INPUT_REFUSED_CODE = 'input_refused'

export type TransitionalLine = { type: 'system'; subtype: 'seat_verb_applied' | 'elicitation_complete'; [key: string]: unknown }
export type OutboundLine = RowDraft | TransitionalLine
export type WireLine = Row | TransitionalLine

export function isRowLine(line: OutboundLine): line is RowDraft {
  return (line as { type: string }).type !== 'system'
}

export function emptyInputRow(row: InputRow): string | null {
  if (row.type === 'prompt' && (row.content === '' || (Array.isArray(row.content) && row.content.length === 0))) return 'a prompt row with no content'
  if (row.type === 'shell' && row.command.trim() === '') return 'a shell row with no command'
  if (row.type === 'note' && (row.to === '' || row.content === '')) return 'a note row with no agent or no content'
  return null
}

export function inputRefusal(parsed: unknown): string | null {
  const check = InputRowSchema().safeParse(parsed)
  const type = parsed !== null && typeof parsed === 'object' ? (parsed as { type?: unknown }).type : undefined
  if (check.success) {
    const empty = emptyInputRow(check.data)
    return empty === null ? null : `input refused: ${empty}`
  }
  if (typeof type !== 'string') return 'input refused: a row needs a type (prompt, shell or note)'
  if (type !== 'prompt' && type !== 'shell' && type !== 'note') return `input refused: unknown row type '${type}' (prompt, shell or note)`
  return `input refused: the ${type} row is malformed — ${check.error.issues.map(issue => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ')}`
}

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<InputRow, void, unknown>
  readonly outbound: Stream<OutboundLine> = new Stream<OutboundLine>()
  readonly rows = createRowStamper()

  readonly #prepended: string[] = []
  readonly #refuse: (text: string) => void

  constructor(input: AsyncIterable<string>, refuse: (text: string) => void = text => logForDebugging(text)) {
    this.#refuse = refuse
    this.structuredInput = this.#createInputStream(input)
  }


  prependUserMessage(content: string): void {
    this.#prepended.push(content)
  }

  #takePrepended(): InputRow[] {
    const taken = this.#prepended.splice(0, this.#prepended.length)
    return taken.map(content => ({ type: 'prompt' as const, content }))
  }

  async *#createInputStream(input: AsyncIterable<string>): AsyncGenerator<InputRow, void, unknown> {
    let buffer = ''
    let bytes = 0
    let skipping = false
    yield* this.#takePrepended()
    for await (const chunk of input) {
      let start = 0
      for (;;) {
        const newlineIndex = chunk.indexOf('\n', start)
        if (!skipping) {
          const part = chunk.slice(start, newlineIndex < 0 ? undefined : newlineIndex)
          bytes += Buffer.byteLength(part, 'utf8')
          if (bytes > MAX_LINE_BYTES) {
            this.#refuse(`input refused: a line longer than ${MAX_LINE_BYTES} bytes was skipped`)
            buffer = ''
            skipping = true
          } else {
            buffer += part
          }
        }
        if (newlineIndex < 0) break
        if (!skipping && buffer.trim().length > 0) {
          const row = this.#classifyLine(stripBOM(buffer), true)
          yield* this.#takePrepended()
          if (row !== undefined) yield row
        }
        buffer = ''
        bytes = 0
        skipping = false
        start = newlineIndex + 1
      }
      yield* this.#takePrepended()
    }
    if (!skipping && buffer.trim().length > 0) {
      const row = this.#classifyLine(stripBOM(buffer), false)
      yield* this.#takePrepended()
      if (row !== undefined) yield row
    }
    yield* this.#takePrepended()
  }


  #classifyLine(line: string, emitDiagnostic: boolean): InputRow | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      fatalProtocolError(`Error parsing stdin line: ${line}\n${error instanceof Error ? error.message : String(error)}`)
    }
    if (emitDiagnostic) {
      logForDiagnosticsNoPII('debug', 'headless_stdin_message', {
        type: String((parsed as { type?: unknown } | null)?.type ?? 'unknown'),
      })
    }
    const refusal = inputRefusal(parsed)
    if (refusal !== null) {
      this.#refuse(refusal)
      return undefined
    }
    return InputRowSchema().parse(parsed)
  }


  stdoutPipeBroken = false

  markStdoutPipeBroken(): void {
    if (this.stdoutPipeBroken) return
    this.stdoutPipeBroken = true
    process.exitCode = 1
    try {
      process.stderr.write(`${BROKEN_STDOUT_LINE}\n`)
    } catch {
    }
  }

  write(message: OutboundLine): Promise<WireLine | null> {
    return new Promise((resolve, reject) => {
      if (this.stdoutPipeBroken) return resolve(null)
      const line: WireLine = isRowLine(message) ? this.rows.stamp(message as never) : (message as TransitionalLine)
      process.stdout.write(`${ndjsonSafeStringify(line)}\n`, error => {
        if (error) {
          if (isBrokenPipeError(error)) {
            this.markStdoutPipeBroken()
            return resolve(null)
          }
          return reject(error)
        }
        resolve(line)
      })
    })
  }
}
