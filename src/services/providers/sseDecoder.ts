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
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.dataLines.push(value)
    else if (field === 'event') this.eventType = value
  }

  flush(): SseDecodeResult[] {
    const finalText = this.decoder.end()
    const out: SseDecodeResult[] = []
    if (finalText) {
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
