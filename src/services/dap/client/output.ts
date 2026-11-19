import type { DapSession } from '../dapClient.js'
import { OUTPUT_RING_MAX } from './shared.js'

export const PARTIAL_OUTPUT_KEEP_BYTES = 64 * 1024
export const RING_LINE_MAX_CHARS = 4_096

interface OutputNeeds {
  pushOutput(line: string): void
}

export class OutputPart {
  #partialOutput = ''

  constructor(private readonly needs: OutputNeeds) {}

  pushOutputChunk(chunk: string): void {
    this.#partialOutput += chunk
    for (;;) {
      const nl = this.#partialOutput.search(/[\r\n]/)
      if (nl === -1) break
      const line = this.#partialOutput.slice(0, nl).trimEnd()
      const next = this.#partialOutput[nl] === '\r' && this.#partialOutput[nl + 1] === '\n' ? nl + 2 : nl + 1
      this.#partialOutput = this.#partialOutput.slice(next)
      if (line) this.needs.pushOutput(line)
    }
    if (this.#partialOutput.length > PARTIAL_OUTPUT_KEEP_BYTES) {
      this.#partialOutput = this.#partialOutput.slice(-PARTIAL_OUTPUT_KEEP_BYTES)
    }
  }

  flushPartialOutput(): void {
    const rest = this.#partialOutput.trimEnd()
    this.#partialOutput = ''
    if (rest) this.needs.pushOutput(rest)
  }
}

export function pushOutput(session: DapSession, line: string): void {
  session.output.push(line)
  if (session.output.length > OUTPUT_RING_MAX) {
    session.output.splice(0, session.output.length - OUTPUT_RING_MAX)
  }
}
