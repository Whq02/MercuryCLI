// ============================================================================
//  strictVtParse — the junk-bytes verifier's core.
//
//  Parses a PTY capture byte-for-byte under the engine's CLOSED grammar
//  (src/render-engine/ansiText.ts — the same tokenizer the emitter's clamp
//  rides): every escape must be complete, every control byte declared, every
//  printable inside the demo alphabet. The defect class this catches is the
//  spinner-adjacent stray-glyph fragment ("r●v"): an interleaved or split
//  sequence surfaces here as a malformed CSI plus out-of-place text.
//
//  Capture format (the rig's recorder): 8B t_ns LE | 1B dir (0=out,1=in) |
//  4B len LE | len bytes.
// ============================================================================

import { tokenizeAnsi, type AnsiToken } from '../../src/render-engine/ansiText.js'
import { firstUnlawfulGlyph, textIsDemoLawful } from './demoAlphabet.js'

export interface CaptureFrames {
  out: Buffer
  frames: number
  outFrames: number
  durationNs: bigint
}

/** Split a .rec capture into the app→terminal byte stream. */
export function readCapture(buf: Buffer): CaptureFrames {
  const chunks: Buffer[] = []
  let frames = 0
  let outFrames = 0
  let offset = 0
  let lastT = 0n
  while (offset + 13 <= buf.length) {
    const t = buf.readBigUInt64LE(offset)
    const dir = buf.readUInt8(offset + 8)
    const len = buf.readUInt32LE(offset + 9)
    offset += 13
    if (offset + len > buf.length) break // torn final frame (recorder killed)
    if (dir === 0) {
      chunks.push(buf.subarray(offset, offset + len))
      outFrames++
    }
    offset += len
    frames++
    lastT = t
  }
  return { out: Buffer.concat(chunks), frames, outFrames, durationNs: lastT }
}

export interface StrictVerdict {
  clean: boolean
  totalBytes: number
  tokens: number
  textRuns: number
  csi: number
  malformed: number
  truncated: number
  foreign: number
  strayC0: number
  disallowedCsi: number
  strayPrintables: number
  sync2026: number
  offenders: string[]
}

export interface StrictRules {
  /** CSI finals the engine may emit on this profile. */
  allowedFinals: Set<string>
  /** h/l private-mode parameter strings the engine may emit. */
  allowedModes: Set<string>
  /** C0 bytes allowed outside escapes. */
  allowedC0: Set<number>
  /** 2026 brackets lawful (armed profile)? The Apple profile says no. */
  allow2026: boolean
}

export const APPLE_PROFILE_RULES: StrictRules = {
  allowedFinals: new Set(['A', 'B', 'G', 'K', 'm', 'h', 'l']),
  allowedModes: new Set(['?25']),
  allowedC0: new Set([0x0d, 0x0a]),
  allow2026: false,
}

const show = (raw: string): string =>
  JSON.stringify(raw.length > 48 ? raw.slice(0, 48) + '…' : raw)

/** Apply the strict rules to one output stream. */
export function verifyStream(out: Buffer, rules: StrictRules): StrictVerdict {
  const tokens = tokenizeAnsi(out)
  const v: StrictVerdict = {
    clean: false,
    totalBytes: out.length,
    tokens: tokens.length,
    textRuns: 0,
    csi: 0,
    malformed: 0,
    truncated: 0,
    foreign: 0,
    strayC0: 0,
    disallowedCsi: 0,
    strayPrintables: 0,
    sync2026: 0,
    offenders: [],
  }
  const offend = (label: string): void => {
    if (v.offenders.length < 12) v.offenders.push(label)
  }
  tokens.forEach((t: AnsiToken, i: number) => {
    switch (t.kind) {
      case 'text': {
        v.textRuns++
        if (!textIsDemoLawful(t.text)) {
          v.strayPrintables++
          offend(`stray printable ${show(firstUnlawfulGlyph(t.text) ?? '')} in run ${show(t.text)}`)
        }
        break
      }
      case 'c0': {
        if (!rules.allowedC0.has(t.byte)) {
          v.strayC0++
          offend(`stray C0 0x${t.byte.toString(16)}`)
        }
        break
      }
      case 'csi': {
        v.csi++
        if (t.params.includes('2026')) {
          v.sync2026++
          if (!rules.allow2026) offend(`2026 sequence on a profile that never armed it: ${show(t.raw)}`)
        }
        if (!rules.allowedFinals.has(t.final)) {
          v.disallowedCsi++
          offend(`CSI final '${t.final}' outside the engine set: ${show(t.raw)}`)
          break
        }
        if ((t.final === 'h' || t.final === 'l') && !rules.allowedModes.has(t.params) &&
            !(rules.allow2026 && t.params === '?2026')) {
          v.disallowedCsi++
          offend(`mode ${show(t.params)} outside the engine set`)
        }
        break
      }
      case 'osc':
      case 'esc-pair': {
        v.disallowedCsi++
        offend(`sequence class the engine never emits: ${show(t.raw)}`)
        break
      }
      case 'foreign': {
        v.foreign++
        offend(`foreign sequence: ${show(t.raw)}`)
        break
      }
      case 'malformed': {
        v.malformed++
        offend(`MALFORMED: ${(t as { reason: string }).reason} ${show(t.raw)}`)
        break
      }
      case 'truncated': {
        // Lawful only as the capture's very last token (a recorder cut).
        if (i !== tokens.length - 1) {
          v.malformed++
          offend(`mid-stream truncation ${show(t.raw)}`)
        } else {
          v.truncated++
        }
        break
      }
    }
  })
  v.clean =
    v.malformed === 0 &&
    v.foreign === 0 &&
    v.strayC0 === 0 &&
    v.disallowedCsi === 0 &&
    v.strayPrintables === 0 &&
    (rules.allow2026 || v.sync2026 === 0) &&
    v.truncated === 0
  return v
}
