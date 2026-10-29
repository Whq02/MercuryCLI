
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { canonicalFrameJson, type Frame } from './frame.js'
import {
  operatorKeyId,
  signAsOperator,
  verifyOperatorSignature,
} from '../../substrate/identity/operatorKey.js'

export function mintSharedSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function authenticatedBytes(frame: Frame): string {
  const { c: _c, sig: _sig, ...rest } = frame
  return canonicalFrameJson(rest)
}

export function signFrame(frame: Frame, secret: string): string {
  return createHmac('sha256', secret).update(authenticatedBytes(frame)).digest('hex')
}

export function verifyFrameSig(frame: Frame, secret: string): boolean {
  if (typeof frame.sig !== 'string' || frame.sig.length === 0) return false
  const expected = signFrame(frame, secret)
  const a = Buffer.from(frame.sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}


export const OPERATOR_SIG_PREFIX = 'op1:'

export function isOperatorSignedFrame(frame: Frame): boolean {
  return typeof frame.sig === 'string' && frame.sig.startsWith(OPERATOR_SIG_PREFIX)
}

export function signFrameAsOperator(frame: Frame): string | null {
  try {
    if (frame.author.kind !== 'operator' || frame.author.id !== operatorKeyId()) return null
    return OPERATOR_SIG_PREFIX + signAsOperator(authenticatedBytes(frame)).toString('base64url')
  } catch {
    return null
  }
}

export function verifyOperatorFrameSig(frame: Frame, publicKeyRaw: Buffer): boolean {
  if (typeof frame.sig !== 'string' || !frame.sig.startsWith(OPERATOR_SIG_PREFIX)) return false
  try {
    const sig = Buffer.from(frame.sig.slice(OPERATOR_SIG_PREFIX.length), 'base64url')
    return verifyOperatorSignature(authenticatedBytes(frame), sig, publicKeyRaw)
  } catch {
    return false
  }
}
