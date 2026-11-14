import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { Input } from './FileReadTool.js'

function spans(input: Input, total: number): Array<{ start: number; end: number }> {
  if (input.ranges?.length) {
    return input.ranges.flatMap(text => text.split(',')).map(text => {
      const range = text.trim()
      const tail = /^-(\d+)$/.exec(range)
      if (tail) return { start: Math.max(1, total - Number(tail[1]) + 1), end: total }
      const plus = /^(\d+)\+(\d+)$/.exec(range)
      if (plus) return { start: Number(plus[1]), end: Number(plus[1]) + Number(plus[2]) - 1 }
      const parts = /^(\d+)(?:-(\d*))?$/.exec(range)
      if (!parts) throw new Error(`Invalid generated-output range: ${range}`)
      return { start: Number(parts[1]), end: parts[2] === '' ? total : Number(parts[2] ?? parts[1]) }
    })
  }
  const start = input.offset !== undefined && input.offset < 0 ? Math.max(1, total + input.offset + 1) : Math.max(1, input.offset ?? 1)
  return [{ start, end: Math.min(total, start + (input.limit ?? 2000) - 1) }]
}

export async function jsonQueryWindow(path: string, total: number, input: Input, maxChars: number, signal: AbortSignal): Promise<{ text: string; cut: boolean; lines: string }> {
  const ranges = spans(input, total)
  const numbered = input.offset !== undefined || input.limit !== undefined || (input.ranges?.length ?? 0) > 0
  let text = '', line = 1, atStart = true, cut = false
  const append = (piece: string): void => {
    const room = Math.max(0, maxChars - text.length)
    if (piece.length > room) cut = true
    text += piece.slice(0, room)
  }
  const consume = (chunk: string): void => {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline + 1
      if (ranges.some(range => line >= range.start && line <= range.end)) {
        if (numbered && atStart) append(`${line}\t`)
        append(chunk.slice(start, end))
      } else if (line <= total) cut = true
      atStart = newline >= 0
      if (newline >= 0) line++
      start = end
    }
  }
  const decoder = new StringDecoder('utf8')
  for await (const chunk of createReadStream(path, { signal, highWaterMark: 65536 })) consume(decoder.write(chunk as Buffer))
  consume(decoder.end())
  return { text, cut, lines: ranges.map(range => range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`).join(', ') }
}
