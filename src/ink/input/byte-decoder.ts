import { Buffer } from 'buffer'

// ============================================================================
//  byte-decoder — the Mercury stdin byte layer.
//
//  RESPONSIBILITY: raw stdin chunks → decoded text, with an incomplete UTF-8
//  TAIL carried between chunks. stdin can split a codepoint anywhere; a lead
//  byte whose continuations haven't arrived is held, not decoded. Bytes that
//  are genuinely invalid decode lossily exactly as a whole-feed would — and a
//  flush decodes whatever is held the same lossy way (the B3 law: a lone 0xC3
//  is a fragment, never a meta key).
//
//  CONTRACT: prove-keypress-corpus UTF-8 probes + prove-input-contract's
//  UTF-8 adversarial law (lone continuation · invalid lead · 4-byte codepoint
//  across three chunks · state hygiene).
// ============================================================================

/** UTF-8 sequence length promised by a lead byte. */
function leadLength(b: number): number {
  if (b >= 0xf0) return 4
  if (b >= 0xe0) return 3
  if (b >= 0xc0) return 2
  return 1
}

/** Split a chunk into its decodable head and the incomplete trailing lead
 *  (if any). Scans back at most 4 bytes: an ASCII byte ends the scan (the
 *  tail is complete); a lead byte needing more bytes than remain is held;
 *  anything else decodes lossily like a whole feed. */
export function splitDecodableHead(buf: Buffer): { text: string; pending: Buffer | undefined } {
  const len = buf.length
  let i = len - 1
  let back = 0
  while (i >= 0 && back < 4) {
    const b = buf[i]!
    if (b < 0x80) break
    if (b >= 0xc0) {
      if (leadLength(b) > len - i) {
        return {
          text: buf.subarray(0, i).toString('utf8'),
          pending: Buffer.from(buf.subarray(i)),
        }
      }
      break
    }
    i--
    back++
  }
  return { text: buf.toString('utf8'), pending: undefined }
}

/** One decode step: previous pending tail × new chunk (Buffer, string, or
 *  null = flush) → text to scan + the new pending tail. String input can't
 *  carry byte fragments — the pending tail is decoded (lossily if invalid)
 *  and prepended. */
export function decodeChunk(
  pending: Buffer | undefined,
  input: Buffer | string | null,
): { text: string; pending: Buffer | undefined } {
  if (input === null) {
    return { text: pending?.length ? pending.toString('utf8') : '', pending: undefined }
  }
  if (Buffer.isBuffer(input)) {
    const combined = pending?.length ? Buffer.concat([pending, input]) : input
    return splitDecodableHead(combined)
  }
  const prefix = pending?.length ? pending.toString('utf8') : ''
  return { text: prefix + input, pending: undefined }
}
