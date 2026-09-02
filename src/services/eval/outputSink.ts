// ============================================================================
//  services/eval/outputSink — the bounded stream sink (head + rolling tail).
//
//  Memory-bounded while streaming: a fixed head window, a rolling tail, and
//  byte/line counters; the raw stream accumulates (capped) for the spill
//  artifact so the model can read the FULL bytes back. Truncation is
//  surrogate-safe and always ANNOTATED — a gap marker names the elided byte
//  count, never a silent cut.
// ============================================================================

import {
  EVAL_HEAD_BYTES,
  EVAL_MAX_LINE_CHARS,
  EVAL_SPILL_MAX_BYTES,
  EVAL_TAIL_BYTES,
  type EvalStreamCapture,
} from './contracts.js'

/** Drop a trailing high surrogate (an in-pair cut). */
function trimTrailingSurrogate(text: string): string {
  if (text.length === 0) return text
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

/** Drop a leading low surrogate (an in-pair cut). */
function trimLeadingSurrogate(text: string): string {
  if (text.length === 0) return text
  const first = text.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text
}

export class BoundedStreamSink {
  private head = ''
  private headBytes = 0
  private tail = ''
  private spillChunks: string[] = []
  private spillBytes = 0
  private spillCapped = false
  totalBytes = 0
  totalLines = 0

  constructor(
    private readonly headLimit: number = EVAL_HEAD_BYTES,
    private readonly tailLimit: number = EVAL_TAIL_BYTES,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) return
    this.totalBytes += Buffer.byteLength(chunk, 'utf8')
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === '\n') this.totalLines++
    if (this.spillBytes < EVAL_SPILL_MAX_BYTES) {
      this.spillChunks.push(chunk)
      this.spillBytes += Buffer.byteLength(chunk, 'utf8')
    } else {
      this.spillCapped = true
    }
    if (this.headBytes < this.headLimit) {
      const room = this.headLimit - this.headBytes
      let take = chunk
      if (Buffer.byteLength(chunk, 'utf8') > room) {
        // Byte-bounded cut: walk back from a generous char estimate.
        let end = Math.min(chunk.length, room)
        while (end > 0 && Buffer.byteLength(chunk.slice(0, end), 'utf8') > room) end--
        take = trimTrailingSurrogate(chunk.slice(0, end))
      }
      this.head += take
      this.headBytes += Buffer.byteLength(take, 'utf8')
      const rest = chunk.slice(take.length)
      if (rest) this.pushTail(rest)
      return
    }
    this.pushTail(chunk)
  }

  private pushTail(chunk: string): void {
    this.tail += chunk
    // Trim the rolling tail from the front, newline-preferring.
    while (Buffer.byteLength(this.tail, 'utf8') > this.tailLimit) {
      const cutAt = this.tail.indexOf('\n', 1)
      if (cutAt > 0 && Buffer.byteLength(this.tail.slice(cutAt + 1), 'utf8') <= this.tailLimit * 2) {
        this.tail = this.tail.slice(cutAt + 1)
      } else {
        this.tail = trimLeadingSurrogate(this.tail.slice(Math.ceil(this.tail.length / 4)))
      }
    }
  }

  /** The full raw capture for the spill artifact (capped at
   *  EVAL_SPILL_MAX_BYTES, with the cap annotated by the caller). */
  rawCapture(): { text: string; capped: boolean } {
    return { text: this.spillChunks.join(''), capped: this.spillCapped }
  }

  /** The rolling tail as it stands (live progress rendering). */
  liveTail(maxChars = 2_000): string {
    const source = this.tail || this.head
    return source.length > maxChars ? trimLeadingSurrogate(source.slice(-maxChars)) : source
  }

  finalize(): EvalStreamCapture {
    const headBytesTotal = this.headBytes
    const tailBytes = Buffer.byteLength(this.tail, 'utf8')
    const truncated = this.totalBytes > headBytesTotal + tailBytes
    let text: string
    if (!truncated) {
      text = this.head + this.tail
    } else {
      const elided = this.totalBytes - headBytesTotal - tailBytes
      text = `${this.head}\n… [${elided} bytes elided — the full stream is in the spill artifact] …\n${this.tail}`
    }
    text = capLines(text)
    return { text, truncated, totalBytes: this.totalBytes, totalLines: this.totalLines }
  }
}

/** Per-line column cap for model-visible text (annotated cuts). */
export function capLines(text: string, maxLine: number = EVAL_MAX_LINE_CHARS): string {
  if (!text.includes('\n') && text.length <= maxLine) return text
  return text
    .split('\n')
    .map(line =>
      line.length > maxLine
        ? `${trimTrailingSurrogate(line.slice(0, maxLine))}… [line truncated: ${line.length} chars]`
        : line,
    )
    .join('\n')
}
