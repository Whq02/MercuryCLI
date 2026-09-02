
import { stringWidth } from '../ink/stringWidth.js'

const ESC = 0x1b

export type AnsiToken =
  | { kind: 'text'; text: string }
  | { kind: 'c0'; byte: number }
  | { kind: 'csi'; params: string; intermediates: string; final: string; raw: string }
  | { kind: 'osc'; body: string; raw: string }
  | { kind: 'esc-pair'; final: string; raw: string }
  | { kind: 'foreign'; raw: string }
  | { kind: 'malformed'; raw: string; reason: string }
  | { kind: 'truncated'; raw: string }

const isCsiParam = (b: number): boolean => b >= 0x30 && b <= 0x3f
const isCsiIntermediate = (b: number): boolean => b >= 0x20 && b <= 0x2f
const isCsiFinal = (b: number): boolean => b >= 0x40 && b <= 0x7e

export const ENGINE_C0 = new Set<number>([0x0d , 0x0a , 0x09 , 0x07 , 0x08 ])

export function tokenizeAnsi(input: Buffer): AnsiToken[] {
  const out: AnsiToken[] = []
  const n = input.length
  let i = 0
  let textStart = -1
  const flushText = (end: number): void => {
    if (textStart >= 0 && end > textStart) {
      out.push({ kind: 'text', text: input.toString('utf8', textStart, end) })
    }
    textStart = -1
  }
  while (i < n) {
    const b = input[i]!
    if (b !== ESC) {
      if (b < 0x20 || b === 0x7f) {
        flushText(i)
        out.push({ kind: 'c0', byte: b })
        i++
        continue
      }
      if (textStart < 0) textStart = i
      i++
      continue
    }
    flushText(i)
    if (i + 1 >= n) {
      out.push({ kind: 'truncated', raw: '\x1b' })
      i = n
      break
    }
    const intro = input[i + 1]!
    if (intro === 0x5b ) {
      let j = i + 2
      let params = ''
      let inter = ''
      let bad = -1
      while (j < n && isCsiParam(input[j]!)) params += String.fromCharCode(input[j++]!)
      while (j < n && isCsiIntermediate(input[j]!)) inter += String.fromCharCode(input[j++]!)
      if (j >= n) {
        out.push({ kind: 'truncated', raw: input.toString('latin1', i, n) })
        i = n
        break
      }
      const fin = input[j]!
      if (isCsiFinal(fin)) {
        const raw = input.toString('latin1', i, j + 1)
        out.push({ kind: 'csi', params, intermediates: inter, final: String.fromCharCode(fin), raw })
        i = j + 1
        continue
      }
      bad = fin
      out.push({
        kind: 'malformed',
        raw: input.toString('latin1', i, j + 1),
        reason: `CSI aborted by byte 0x${bad.toString(16)}`,
      })
      i = j + 1
      continue
    }
    if (intro === 0x5d ) {
      let j = i + 2
      while (j < n) {
        const c = input[j]!
        if (c === 0x07) {
          out.push({
            kind: 'osc',
            body: input.toString('latin1', i + 2, j),
            raw: input.toString('latin1', i, j + 1),
          })
          break
        }
        if (c === ESC) {
          if (j + 1 < n && input[j + 1] === 0x5c ) {
            out.push({
              kind: 'osc',
              body: input.toString('latin1', i + 2, j),
              raw: input.toString('latin1', i, j + 2),
            })
            j++
            break
          }
          out.push({
            kind: 'malformed',
            raw: input.toString('latin1', i, j + 1),
            reason: 'OSC aborted by a bare ESC',
          })
          break
        }
        j++
      }
      if (j >= n) {
        out.push({ kind: 'truncated', raw: input.toString('latin1', i, n) })
        i = n
        break
      }
      i = j + 1
      continue
    }
    if (intro === 0x50  || intro === 0x5e  || intro === 0x5f  || intro === 0x58 ) {
      let j = i + 2
      let closed = false
      while (j < n) {
        if (input[j] === ESC && j + 1 < n && input[j + 1] === 0x5c) {
          closed = true
          break
        }
        j++
      }
      if (!closed) {
        out.push({ kind: 'truncated', raw: input.toString('latin1', i, n) })
        i = n
        break
      }
      out.push({ kind: 'foreign', raw: input.toString('latin1', i, j + 2) })
      i = j + 2
      continue
    }
    if (intro >= 0x40 && intro <= 0x5f) {
      out.push({ kind: 'foreign', raw: input.toString('latin1', i, i + 2) })
      i += 2
      continue
    }
    if ((intro >= 0x30 && intro <= 0x7e) || intro === 0x20) {
      out.push({ kind: 'esc-pair', final: String.fromCharCode(intro), raw: input.toString('latin1', i, i + 2) })
      i += 2
      continue
    }
    out.push({
      kind: 'malformed',
      raw: input.toString('latin1', i, i + 2),
      reason: `ESC before unclassifiable byte 0x${intro.toString(16)}`,
    })
    i += 2
  }
  flushText(n)
  return out
}

export function clampRowToWidth(row: string, cols: number): string {
  if (stringWidth(row) <= cols) return row
  const tokens = tokenizeAnsi(Buffer.from(row, 'utf8'))
  let used = 0
  let out = ''
  for (const t of tokens) {
    if (t.kind === 'text') {
      if (used >= cols) continue
      let piece = ''
      for (const ch of t.text) {
        const w = stringWidth(ch)
        if (used + w > cols) break
        piece += ch
        used += w
      }
      out += piece
      continue
    }
    out +=
      t.kind === 'c0'
        ? String.fromCharCode(t.byte)
        : (t as { raw: string }).raw
  }
  return out
}
