/**
 * Frame signing — authorship a reader can verify.
 *
 * Today's one signer: HMAC-SHA256 under a shared secret, for frames that
 * arrive over a NETWORK transport (the remote listener requires a valid
 * `sig`; a same-machine writer over the daemon's 0600 unix socket is
 * trusted by the OS boundary and carries none — that split is deliberate:
 * no MAC cost on the hot local path, no trust on the network path).
 *
 * The signed bytes are the frame's canonical JSON with `sig` ABSENT (you
 * cannot sign your own signature) and `c` absent (the CRC is storage
 * integrity, computed after sealing) — exactly canonicalFrameJson of the
 * envelope minus sig, so the CRC and the signature can never disagree
 * about what was signed.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { canonicalFrameJson, type Frame } from './frame.js'
import {
  operatorKeyId,
  signAsOperator,
  verifyOperatorSignature,
} from '../../substrate/identity/operatorKey.js'

/** Mint a fresh shared signing secret (32 random bytes, base64url). */
export function mintSharedSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** The bytes a frame is authenticated over: canonical JSON, `sig` and `c`
 *  absent. Exported so other signers (the operator-key authorship) sign
 *  EXACTLY the same bytes as the HMAC path. */
export function authenticatedBytes(frame: Frame): string {
  const { c: _c, sig: _sig, ...rest } = frame
  return canonicalFrameJson(rest)
}

/** Compute the HMAC-SHA256 (hex) a remote frame should carry as `sig`. */
export function signFrame(frame: Frame, secret: string): string {
  return createHmac('sha256', secret).update(authenticatedBytes(frame)).digest('hex')
}

/** Constant-time verify of a remote frame's `sig` against the shared secret. */
export function verifyFrameSig(frame: Frame, secret: string): boolean {
  if (typeof frame.sig !== 'string' || frame.sig.length === 0) return false
  const expected = signFrame(frame, secret)
  const a = Buffer.from(frame.sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

// ── operator authorship (ledger L27 item 9) ─────────────────────────────────
// The frame-signing primitive generalized to the OPERATOR KEY: a signed
// authorship for local frames too. Additive by law — the local socket's
// OS-boundary trust stays the hot path's gate, a reader that does not verify
// ignores the field, and a solo session NEVER gates on signing (every
// failure below is a null/false, never a throw).

/** Tag distinguishing an operator AUTHORSHIP signature from the HMAC hex —
 *  the two signers can never be confused at a verifier. */
export const OPERATOR_SIG_PREFIX = 'op1:'

export function isOperatorSignedFrame(frame: Frame): boolean {
  return typeof frame.sig === 'string' && frame.sig.startsWith(OPERATOR_SIG_PREFIX)
}

/**
 * Sign a sealed frame's authenticated bytes as the operator — ONLY when the
 * frame's author IS this box's keyed operator (the signature claims "the key
 * whose hash is the author id wrote this"; signing anyone else's frame would
 * mint a false claim). Null when the author is someone else or the key is
 * unavailable.
 */
export function signFrameAsOperator(frame: Frame): string | null {
  try {
    if (frame.author.kind !== 'operator' || frame.author.id !== operatorKeyId()) return null
    return OPERATOR_SIG_PREFIX + signAsOperator(authenticatedBytes(frame)).toString('base64url')
  } catch {
    return null
  }
}

/**
 * Verify a frame's operator authorship against the raw public key its
 * author advertised (the author id must BE that key's hash — the caller's
 * key exchange establishes the pairing; the next multiplayer's "may I?"
 * gate and cross-board attribution build on this). False on any mismatch.
 */
export function verifyOperatorFrameSig(frame: Frame, publicKeyRaw: Buffer): boolean {
  if (typeof frame.sig !== 'string' || !frame.sig.startsWith(OPERATOR_SIG_PREFIX)) return false
  try {
    const sig = Buffer.from(frame.sig.slice(OPERATOR_SIG_PREFIX.length), 'base64url')
    return verifyOperatorSignature(authenticatedBytes(frame), sig, publicKeyRaw)
  } catch {
    return false
  }
}
