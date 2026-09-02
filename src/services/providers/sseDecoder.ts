// ============================================================================
//  providers/sseDecoder — a spec-correct SSE event decoder (lifted
//  to the shared providers root by — the Z.AI chat-completions wire and
//  the native OpenAI Responses wire decode through this ONE owner).
//
//  There is NO in-repo SSE parser to reuse (the Anthropic one lives inside the
//  SDK — recon), so the provider lanes bring their own. Scope: the
//  text/event-stream subset those wires actually use —
//  `data:` field lines, `event:` types, comment lines, blank-line dispatch —
//  implemented per the SSE spec so fragmented frames survive:
//
//    - CHUNK BOUNDARIES ARE ARBITRARY: partial lines carry across push()es,
//      multi-event chunks fan out, CRLF and LF both terminate lines, a
//      multi-byte UTF-8 sequence split across reads decodes intact;
//    - multiple `data:` lines in one event join with '\n' (spec rule);
//    - comment lines (leading ':') and unknown fields are skipped;
//    - the decoder yields RAW event payload strings — '[DONE]' sentinels and
//      JSON parsing belong to the caller (they are wire-protocol, not SSE);
//    - flush() surfaces a dangling unterminated event at EOF (data lines
//      without the final blank-line dispatch) — recorded, never silent.
// ============================================================================
import { StringDecoder } from 'node:string_decoder'

export interface SseEvent {
  data: string
  event?: string
}

export type SseDecodeResult =
  | { kind: 'event'; event: SseEvent }
  | { kind: 'fault'; reason: 'dangling-event'; preview: string }

export class SseDecoder {
  private tail = ''
  private dataLines: string[] = []
  private eventType: string | undefined
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer | string): SseDecodeResult[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const out: SseDecodeResult[] = []
    // Cursor scan: one slice per line and at most ONE tail slice per chunk.
    // (The previous shape re-sliced the whole remainder once per line — a
    // shrinking-buffer copy per line on multi-line chunks.) A lone trailing
    // '\r' is excluded by charcode, matching the old replace(/\r$/, '').
    const buf = this.tail === '' ? text : this.tail + text
    let pos = 0
    for (;;) {
      const nl = buf.indexOf('\n', pos)
      if (nl === -1) break
      const end = nl > pos && buf.charCodeAt(nl - 1) === 13 ? nl - 1 : nl
      this.consumeLine(buf.slice(pos, end), out)
      pos = nl + 1
    }
    this.tail = pos === 0 ? buf : buf.slice(pos)
    return out
  }

  private consumeLine(line: string, out: SseDecodeResult[]): void {
    if (line === '') {
      // Dispatch boundary.
      if (this.dataLines.length > 0) {
        out.push({
          kind: 'event',
          event: {
            data: this.dataLines.join('\n'),
            ...(this.eventType !== undefined ? { event: this.eventType } : {}),
          },
        })
      }
      this.dataLines = []
      this.eventType = undefined
      return
    }
    if (line.startsWith(':')) return // comment
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.dataLines.push(value)
    else if (field === 'event') this.eventType = value
    // id / retry / unknown fields: not consumed by this wire.
  }

  flush(): SseDecodeResult[] {
    const finalText = this.decoder.end()
    const out: SseDecodeResult[] = []
    if (finalText) {
      // A trailing fragment without its newline still forms a line at EOF.
      const line = (this.tail + finalText).replace(/\r$/, '')
      this.tail = ''
      if (line !== '') this.consumeLine(line, out)
    } else if (this.tail !== '') {
      this.consumeLine(this.tail.replace(/\r$/, ''), out)
      this.tail = ''
    }
    if (this.dataLines.length > 0) {
      out.push({
        kind: 'fault',
        reason: 'dangling-event',
        preview: this.dataLines.join('\n').slice(0, 200),
      })
      this.dataLines = []
      this.eventType = undefined
    }
    return out
  }
}
