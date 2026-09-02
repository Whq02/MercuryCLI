import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto'
import type { TrustedSigningKey } from './signingTrust.js'

export interface SigningStatementV1 {
  schema: 1
  name: string
  version: string
  channel: string
  target: string
  packagedAt: string
  buildTree: string | null
  primarySha256: string
  payloadDigest: string
  licenseId: string | null
}

const STATEMENT_KEYS = [
  'schema',
  'name',
  'version',
  'channel',
  'target',
  'packagedAt',
  'buildTree',
  'primarySha256',
  'payloadDigest',
  'licenseId',
] as const

const HEX64 = /^[0-9a-f]{64}$/

export function parseStatement(value: unknown): { state: 'ok'; statement: SigningStatementV1 } | { state: 'malformed'; note: string } {
  if (typeof value !== 'object' || value === null) return { state: 'malformed', note: 'statement is not an object' }
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) {
    if (!(STATEMENT_KEYS as readonly string[]).includes(key)) {
      return { state: 'malformed', note: `statement carries an unknown key "${key}" outside the signed grammar` }
    }
  }
  if (v.schema !== 1) return { state: 'malformed', note: `statement schema ${String(v.schema)} — this verifier decodes schema 1` }
  for (const key of ['name', 'version', 'channel', 'target', 'packagedAt'] as const) {
    if (typeof v[key] !== 'string' || v[key] === '') return { state: 'malformed', note: `statement.${key} is not a non-empty string` }
  }
  if (!(typeof v.buildTree === 'string' || v.buildTree === null)) {
    return { state: 'malformed', note: 'statement.buildTree is neither string nor null' }
  }
  for (const key of ['primarySha256', 'payloadDigest'] as const) {
    if (typeof v[key] !== 'string' || !HEX64.test(v[key] as string)) {
      return { state: 'malformed', note: `statement.${key} is not a 64-hex sha256` }
    }
  }
  if (!(typeof v.licenseId === 'string' || v.licenseId === null)) {
    return { state: 'malformed', note: 'statement.licenseId is neither string nor null' }
  }
  return { state: 'ok', statement: v as unknown as SigningStatementV1 }
}

export function canonicalStatementBytes(statement: SigningStatementV1): Buffer {
  const ordered: Record<string, unknown> = {}
  for (const key of STATEMENT_KEYS) ordered[key] = statement[key]
  return Buffer.from(JSON.stringify(ordered), 'utf8')
}

export function keyIdOf(publicKeySpkiB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeySpkiB64, 'base64')).digest('hex').slice(0, 16)
}

export interface SignatureBlockV1 {
  schema: 1
  algorithm: 'ed25519'
  keyId: string
  publicKeySpkiB64: string
  statement: SigningStatementV1
  signatureB64: string
}

export function signStatement(statement: SigningStatementV1, privateKeyPem: string): SignatureBlockV1 {
  const key: KeyObject = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`signing key is ${String(key.asymmetricKeyType)} — the artifact signature law is ed25519`)
  }
  const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' })
  const publicKeySpkiB64 = publicDer.toString('base64')
  const signature = edSign(null, canonicalStatementBytes(statement), key)
  return {
    schema: 1,
    algorithm: 'ed25519',
    keyId: keyIdOf(publicKeySpkiB64),
    publicKeySpkiB64,
    statement,
    signatureB64: signature.toString('base64'),
  }
}

export type SignatureVerdict =
  | { state: 'signed'; keyId: string; keyLabel: string; statement: SigningStatementV1 }
  | { state: 'unsigned' }
  | { state: 'unrecognized-key'; keyId: string; statement: SigningStatementV1 }
  | { state: 'tampered'; note: string }
  | { state: 'malformed'; note: string }

export interface ContentBinds {
  manifestVersion: string | null
  primarySha256: string | null
  payloadDigest: string | null
}

export function verifySignatureBlock(
  blockValue: unknown,
  binds: ContentBinds,
  roster: TrustedSigningKey[],
): SignatureVerdict {
  if (blockValue === undefined || blockValue === null) return { state: 'unsigned' }
  if (typeof blockValue !== 'object') return { state: 'malformed', note: 'manifest.signing is not an object' }
  const block = blockValue as Record<string, unknown>
  if (block.schema !== 1) return { state: 'malformed', note: `signing schema ${String(block.schema)} — this verifier decodes schema 1` }
  if (block.algorithm !== 'ed25519') return { state: 'malformed', note: `signing algorithm ${String(block.algorithm)} — the law is ed25519` }
  if (typeof block.publicKeySpkiB64 !== 'string' || typeof block.signatureB64 !== 'string' || typeof block.keyId !== 'string') {
    return { state: 'malformed', note: 'signing block is missing keyId/publicKeySpkiB64/signatureB64' }
  }
  const parsed = parseStatement(block.statement)
  if (parsed.state !== 'ok') return { state: 'malformed', note: parsed.note }
  const statement = parsed.statement

  if (binds.manifestVersion !== null && statement.version !== binds.manifestVersion) {
    return { state: 'tampered', note: `signed version ${statement.version} does not match the manifest's ${binds.manifestVersion}` }
  }
  if (binds.primarySha256 !== null && statement.primarySha256 !== binds.primarySha256) {
    return { state: 'tampered', note: `primary bundle bytes differ from the signed sha256 (signed ${statement.primarySha256.slice(0, 12)}…, actual ${binds.primarySha256.slice(0, 12)}…)` }
  }
  if (binds.payloadDigest !== null && statement.payloadDigest !== binds.payloadDigest) {
    return { state: 'tampered', note: `payload tree differs from the signed digest (signed ${statement.payloadDigest.slice(0, 12)}…, actual ${binds.payloadDigest.slice(0, 12)}…)` }
  }

  let signatureOk = false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(block.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return { state: 'malformed', note: `embedded public key is ${String(publicKey.asymmetricKeyType)} — the law is ed25519` }
    }
    signatureOk = edVerify(null, canonicalStatementBytes(statement), publicKey, Buffer.from(block.signatureB64, 'base64'))
  } catch (e) {
    return { state: 'malformed', note: `embedded public key undecodable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
  }
  if (!signatureOk) {
    return { state: 'tampered', note: 'signature does not verify over the canonical statement bytes' }
  }
  const embeddedKeyId = keyIdOf(block.publicKeySpkiB64)
  if (embeddedKeyId !== block.keyId) {
    return { state: 'tampered', note: `declared keyId ${block.keyId} does not match the embedded key (${embeddedKeyId})` }
  }
  const trusted = roster.find(k => k.publicKeySpkiB64 === block.publicKeySpkiB64 && k.keyId === embeddedKeyId)
  if (!trusted) return { state: 'unrecognized-key', keyId: embeddedKeyId, statement }
  return { state: 'signed', keyId: trusted.keyId, keyLabel: trusted.label, statement }
}

export function describeSignatureVerdict(verdict: SignatureVerdict): string {
  switch (verdict.state) {
    case 'signed': {
      const lic = verdict.statement.licenseId ? ` · license-id ${verdict.statement.licenseId}` : ''
      return `signed — key ${verdict.keyId} (${verdict.keyLabel}) · ${verdict.statement.version} · ${verdict.statement.channel}/${verdict.statement.target} · packaged ${verdict.statement.packagedAt}${lic}`
    }
    case 'unsigned':
      return 'unsigned — the payload manifest carries no signing block; provenance is unattested'
    case 'unrecognized-key': {
      const lic = verdict.statement.licenseId ? ` · license-id ${verdict.statement.licenseId}` : ''
      return `signature valid but key ${verdict.keyId} is NOT in this build's trusted roster — provenance unattested${lic}`
    }
    case 'tampered':
      return `TAMPERED — ${verdict.note}`
    case 'malformed':
      return `signing block malformed — ${verdict.note}`
  }
}
