import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

import type { ProtectorAnswer, SystemProtector } from './types.js'

export const SEALED_FIELD = 'mercurySealed'

const FORMAT = '1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const UNANSWERED_HOLD_MS = 30_000
const SCHEME = /^[a-z0-9-]+$/
const SEGMENT = /^[A-Za-z0-9_-]+$/

export type SealedOpen = { ok: true; data: Record<string, unknown> } | { ok: false; why: string }
type SealedText = { ok: true; text: string } | { ok: false; why: string }

export interface KeyCustody {
  readonly scheme: string
  open(text: string): SealedOpen
  openAsync(text: string): Promise<SealedOpen>
  seal(data: Record<string, unknown>, beside?: string): SealedText
  sealAsync(data: Record<string, unknown>, beside?: string): Promise<SealedText>
}

type Parts = { scheme: string; token: string; head: string; iv: Buffer; tag: Buffer; data: Buffer }
type KeyAnswer = { ok: true; key: Buffer } | { ok: false; why: string }
type TokenAnswer = { ok: true; token: string } | { ok: false; why: string }
type Refusal = { why: string; until: number | null; asynchronous: boolean }

function parts(text: string): Parts | null {
  const fields = text.split('.')
  if (fields.length !== 6) return null
  const [format, scheme, token, iv, tag, data] = fields as [string, string, string, string, string, string]
  if (format !== FORMAT || !SCHEME.test(scheme)) return null
  if (![token, iv, tag, data].every(field => SEGMENT.test(field))) return null
  const ivBytes = Buffer.from(iv, 'base64url')
  const tagBytes = Buffer.from(tag, 'base64url')
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) return null
  return { scheme, token, head: `${format}.${scheme}.${token}`, iv: ivBytes, tag: tagBytes, data: Buffer.from(data, 'base64url') }
}

function encrypt(plain: string, key: Buffer, head: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(head, 'utf8'))
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [head, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

function decrypt(sealed: Parts, key: Buffer): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(sealed.head, 'utf8'))
    decipher.setAuthTag(sealed.tag)
    return Buffer.concat([decipher.update(sealed.data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

function recordOf(plain: string): SealedOpen {
  let parsed: unknown
  try {
    parsed = JSON.parse(plain)
  } catch {
    return { ok: false, why: 'the sealed text opened to something that is not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, why: 'the sealed text opened to something that is not an object' }
  }
  return { ok: true, data: parsed as Record<string, unknown> }
}

export function createKeyCustody(protector: SystemProtector, now: () => number = Date.now): KeyCustody {
  const held = new Map<string, Buffer>()
  const refused = new Map<string, Refusal>()
  const unwrapping = new Map<string, Promise<KeyAnswer>>()
  let latest: string | null = null
  let noNewKey: Refusal | null = null

  function refusal(why: string, final: boolean, asynchronous: boolean): Refusal {
    return { why, until: final ? null : now() + UNANSWERED_HOLD_MS, asynchronous }
  }

  function stands(no: Refusal, synchronous: boolean): boolean {
    if (no.until === null) return true
    return now() < no.until && !(synchronous && no.asynchronous)
  }

  function known(token: string, synchronous: boolean): KeyAnswer | null {
    const key = held.get(token)
    if (key !== undefined) return { ok: true, key }
    const no = refused.get(token)
    return no !== undefined && stands(no, synchronous) ? { ok: false, why: no.why } : null
  }

  function settle(token: string, answer: ProtectorAnswer, synchronous: boolean): KeyAnswer {
    const key = held.get(token)
    if (key !== undefined) return { ok: true, key }
    if (answer.ok && answer.bytes.length === KEY_BYTES) {
      held.set(token, answer.bytes)
      refused.delete(token)
      latest = token
      return { ok: true, key: answer.bytes }
    }
    const no = answer.ok
      ? refusal(`the key came back as ${answer.bytes.length} bytes, not ${KEY_BYTES}`, true, !synchronous)
      : refusal(answer.why, answer.final, !synchronous)
    const before = refused.get(token)
    if (synchronous || before === undefined || !stands(before, false)) refused.set(token, no)
    return { ok: false, why: no.why }
  }

  function keyOf(token: string): KeyAnswer {
    return known(token, true) ?? settle(token, protector.unprotect(Buffer.from(token, 'base64url')), true)
  }

  function keyOfAsync(token: string): Promise<KeyAnswer> {
    const have = known(token, false)
    if (have !== null) return Promise.resolve(have)
    const flying = unwrapping.get(token)
    if (flying !== undefined) return flying
    const asked = protector
      .unprotectAsync(Buffer.from(token, 'base64url'))
      .then(answer => settle(token, answer, false))
      .finally(() => {
        unwrapping.delete(token)
      })
    unwrapping.set(token, asked)
    return asked
  }

  function readable(text: string): { ok: true; sealed: Parts } | { ok: false; why: string } {
    const sealed = parts(text)
    if (sealed === null) return { ok: false, why: 'the sealed text is not in a form this build reads' }
    if (sealed.scheme !== protector.scheme) {
      return { ok: false, why: `the sealed text was made by ${sealed.scheme}, and this system answers as ${protector.scheme}` }
    }
    return { ok: true, sealed }
  }

  function opened(sealed: Parts, key: KeyAnswer): SealedOpen {
    if (!key.ok) return key
    const plain = decrypt(sealed, key.key)
    return plain === null ? { ok: false, why: 'the sealed text does not match its key' } : recordOf(plain)
  }

  function refuseNewKey(why: string, final: boolean): TokenAnswer {
    noNewKey = refusal(why, final, false)
    return { ok: false, why }
  }

  function adopt(key: Buffer, wrapped: Buffer, back: ProtectorAnswer): TokenAnswer {
    if (!back.ok) return refuseNewKey(`a new key did not come back through the protector: ${back.why}`, back.final)
    if (back.bytes.length !== KEY_BYTES || !timingSafeEqual(back.bytes, key)) {
      return refuseNewKey('a new key came back through the protector changed', true)
    }
    const token = wrapped.toString('base64url')
    held.set(token, key)
    latest = token
    noNewKey = null
    return { ok: true, token }
  }

  function heldToken(beside: string | undefined): string | null {
    const sealed = beside === undefined ? null : parts(beside)
    return sealed !== null && sealed.scheme === protector.scheme && held.has(sealed.token) ? sealed.token : latest
  }

  function standing(beside: string | undefined): TokenAnswer | null {
    const token = heldToken(beside)
    if (token !== null) return { ok: true, token }
    return noNewKey !== null && stands(noNewKey, false) ? { ok: false, why: noNewKey.why } : null
  }

  function written(data: Record<string, unknown>, token: TokenAnswer): SealedText {
    if (!token.ok) return token
    const key = held.get(token.token)
    if (key === undefined) return { ok: false, why: 'the key for the sealed text is not held' }
    const plain = JSON.stringify(data)
    const text = encrypt(plain, key, `${FORMAT}.${protector.scheme}.${token.token}`)
    const back = parts(text)
    if (back === null || decrypt(back, key) !== plain) return { ok: false, why: 'the sealed text did not read back' }
    return { ok: true, text }
  }

  return {
    scheme: protector.scheme,

    open(text: string): SealedOpen {
      const read = readable(text)
      return read.ok ? opened(read.sealed, keyOf(read.sealed.token)) : read
    },

    async openAsync(text: string): Promise<SealedOpen> {
      const read = readable(text)
      return read.ok ? opened(read.sealed, await keyOfAsync(read.sealed.token)) : read
    },

    seal(data: Record<string, unknown>, beside?: string): SealedText {
      const have = standing(beside)
      if (have !== null) return written(data, have)
      const key = randomBytes(KEY_BYTES)
      const wrapped = protector.protect(key)
      if (!wrapped.ok) return written(data, refuseNewKey(wrapped.why, wrapped.final))
      return written(data, adopt(key, wrapped.bytes, protector.unprotect(wrapped.bytes)))
    },

    async sealAsync(data: Record<string, unknown>, beside?: string): Promise<SealedText> {
      const have = standing(beside)
      if (have !== null) return written(data, have)
      const key = randomBytes(KEY_BYTES)
      const wrapped = await protector.protectAsync(key)
      if (!wrapped.ok) return written(data, refuseNewKey(wrapped.why, wrapped.final))
      const back = await protector.unprotectAsync(wrapped.bytes)
      const meanwhile = heldToken(beside)
      return written(data, meanwhile === null ? adopt(key, wrapped.bytes, back) : { ok: true, token: meanwhile })
    },
  }
}
