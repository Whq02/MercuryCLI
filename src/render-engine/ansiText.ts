// ============================================================================
//  render-engine/ansiText.ts — the engine's byte grammar, one place.
//
//  The emitted vocabulary is CLOSED (E4): every sequence the engine writes
//  is one this tokenizer describes and the replay oracle understands. The
//  strict junk-bytes verifier parses captures with the SAME grammar, so an
//  incomplete escape, an orphaned fragment, or a foreign byte is a mechanical
//  failure, not a judgement call.
//
//  Tokens: printable text runs, C0 controls (CR, LF, TAB, BEL, BS), CSI
//  sequences (parameter/intermediate/final byte classes per ECMA-48), OSC
//  strings (BEL- or ST-terminated), and the ESC-pair forms the engine never
//  emits but a strict parser must still CLASSIFY to fail loudly (DCS/APC/PM/
//  SOS reach 'foreign', a bare ESC before a non-introducer is 'malformed').
// ============================================================================

import { stringWidth } from '../ink/stringWidth.js'

const ESC = 0x1b

export type AnsiToken =
  | { kind: 'text'; text: string }
  | { kind: 'c0'; byte: number }
  | { kind: 'csi'; params: string; intermediates: string; final: string; raw: string }
  | { kind: 'osc'; body: string; raw: string }
  | { kind: 'esc-pair'; final: string; raw: string }
  /** A structurally complete sequence class the ENGINE never emits. */
  | { kind: 'foreign'; raw: string }
  /** An incomplete or ill-formed escape — always a failure for engine output. */
  | { kind: 'malformed'; raw: string; reason: string }
  /** Bytes cut at end-of-capture mid-sequence (only lawful at true EOF). */
  | { kind: 'truncated'; raw: string }

const isCsiParam = (b: number): boolean => b >= 0x30 && b <= 0x3f
const isCsiIntermediate = (b: number): boolean => b >= 0x20 && b <= 0x2f
const isCsiFinal = (b: number): boolean => b >= 0x40 && b <= 0x7e

/** C0 bytes the engine may emit as themselves. */
export const ENGINE_C0 = new Set<number>([0x0d /*CR*/, 0x0a /*LF*/, 0x09 /*TAB*/, 0x07 /*BEL*/, 0x08 /*BS*/])

/**
 * Tokenize a byte stream (as a binary string / Buffer) under the closed
 * grammar. Never throws: malformed input becomes 'malformed'/'foreign'
 * tokens for the verifier to count.
 */
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
    // ESC at i.
    if (i + 1 >= n) {
      out.push({ kind: 'truncated', raw: '\x1b' })
      i = n
      break
    }
    const intro = input[i + 1]!
    if (intro === 0x5b /* [ */) {
      // CSI: params, intermediates, final.
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
    if (intro === 0x5d /* ] */) {
      // OSC: body until BEL or ST (ESC \). Any other ESC inside aborts.
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
          if (j + 1 < n && input[j + 1] === 0x5c /* \\ */) {
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
    if (intro === 0x50 /* P DCS */ || intro === 0x5e /* ^ PM */ || intro === 0x5f /* _ APC */ || intro === 0x58 /* X SOS */) {
      // ST-terminated string sequence — complete it, classify foreign.
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
      // Other C1-introducer ESC pairs (ESC 7/8 fall below this range).
      out.push({ kind: 'foreign', raw: input.toString('latin1', i, i + 2) })
      i += 2
      continue
    }
    if ((intro >= 0x30 && intro <= 0x7e) || intro === 0x20) {
      // Two-byte ESC pair (ESC 7, ESC 8, ESC =, ESC >, …).
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

/**
 * Clamp one styled row to at most `cols` cells. Escape sequences pass
 * through whole (a cut never lands inside one); text runs are cut on code
 * points by the product's one width oracle. Over-wide rows clamp, never
 * throw.
 */
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
    // Every non-text token passes through whole: styling must stay balanced
    // even on a clamped row (a dropped reset would bleed style downward).
    out +=
      t.kind === 'c0'
        ? String.fromCharCode(t.byte)
        : (t as { raw: string }).raw
  }
  return out
}
