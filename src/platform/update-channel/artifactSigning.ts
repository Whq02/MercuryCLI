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
    if (!STATEMENT_KEYS.some(known => known === key)) {
      return { state: 'malformed', note: `statement carries an unknown key "${key}" outside the signed grammar` }
    }
  }
  const { schema, name, version, channel, target, packagedAt, buildTree, primarySha256, payloadDigest, licenseId } = v
  if (schema !== 1) return { state: 'malformed', note: `statement schema ${String(schema)} — this verifier decodes schema 1` }
  if (typeof name !== 'string' || name === '') return { state: 'malformed', note: 'statement.name is not a non-empty string' }
  if (typeof version !== 'string' || version === '') return { state: 'malformed', note: 'statement.version is not a non-empty string' }
  if (typeof channel !== 'string' || channel === '') return { state: 'malformed', note: 'statement.channel is not a non-empty string' }
  if (typeof target !== 'string' || target === '') return { state: 'malformed', note: 'statement.target is not a non-empty string' }
  if (typeof packagedAt !== 'string' || packagedAt === '') return { state: 'malformed', note: 'statement.packagedAt is not a non-empty string' }
  if (typeof buildTree !== 'string' && buildTree !== null) {
    return { state: 'malformed', note: 'statement.buildTree is neither string nor null' }
  }
  if (typeof primarySha256 !== 'string' || !HEX64.test(primarySha256)) {
    return { state: 'malformed', note: 'statement.primarySha256 is not a 64-hex sha256' }
  }
  if (typeof payloadDigest !== 'string' || !HEX64.test(payloadDigest)) {
    return { state: 'malformed', note: 'statement.payloadDigest is not a 64-hex sha256' }
  }
  if (typeof licenseId !== 'string' && licenseId !== null) {
    return { state: 'malformed', note: 'statement.licenseId is neither string nor null' }
  }
  return {
    state: 'ok',
    statement: { schema, name, version, channel, target, packagedAt, buildTree, primarySha256, payloadDigest, licenseId },
  }
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

interface DetachedSignature {
  keyId: string
  publicKeySpkiB64: string
  signatureB64: string
}

function signBytes(bytes: Buffer, privateKeyPem: string): DetachedSignature {
  const key: KeyObject = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`signing key is ${String(key.asymmetricKeyType)} — the artifact signature law is ed25519`)
  }
  const publicKeySpkiB64 = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
  return { keyId: keyIdOf(publicKeySpkiB64), publicKeySpkiB64, signatureB64: edSign(null, bytes, key).toString('base64') }
}

export function signStatement(statement: SigningStatementV1, privateKeyPem: string): SignatureBlockV1 {
  const { keyId, publicKeySpkiB64, signatureB64 } = signBytes(canonicalStatementBytes(statement), privateKeyPem)
  return { schema: 1, algorithm: 'ed25519', keyId, publicKeySpkiB64, statement, signatureB64 }
}

interface ArchiveSignatureV1 extends DetachedSignature {
  schema: 1
  algorithm: 'ed25519'
}

const archiveSignedBytes = (archiveName: string, sha256: string): Buffer => Buffer.from(`mercury-archive-v1\n${archiveName}\n${sha256}\n`, 'utf8')

export function signArchive(archiveName: string, sha256: string, privateKeyPem: string): ArchiveSignatureV1 {
  return { schema: 1, algorithm: 'ed25519', ...signBytes(archiveSignedBytes(archiveName, sha256), privateKeyPem) }
}

export type SignatureVerdict =
  | { state: 'signed'; keyId: string; keyLabel: string; statement: SigningStatementV1 }
  | { state: 'unsigned' }
  | { state: 'unrecognized-key'; keyId: string; statement: SigningStatementV1 }
  | { state: 'tampered'; note: string }
  | { state: 'malformed'; note: string }

interface ContentBinds {
  manifestVersion: string | null
  primarySha256: string | null
  payloadDigest: string | null
}

type DetachedVerdict =
  | { state: 'signed'; keyId: string; keyLabel: string }
  | { state: 'unrecognized-key'; keyId: string }
  | { state: 'tampered'; note: string }
  | { state: 'malformed'; note: string }

function detachedSignatureOf(value: object, where: string): { state: 'ok'; block: Record<string, unknown>; signed: DetachedSignature } | { state: 'malformed'; note: string } {
  const block = value as Record<string, unknown>
  if (block.schema !== 1) return { state: 'malformed', note: `signing schema ${String(block.schema)} — this verifier decodes schema 1` }
  if (block.algorithm !== 'ed25519') return { state: 'malformed', note: `signing algorithm ${String(block.algorithm)} — the law is ed25519` }
  if (typeof block.publicKeySpkiB64 !== 'string' || typeof block.signatureB64 !== 'string' || typeof block.keyId !== 'string') {
    return { state: 'malformed', note: `${where} is missing keyId/publicKeySpkiB64/signatureB64` }
  }
  return { state: 'ok', block, signed: { keyId: block.keyId, publicKeySpkiB64: block.publicKeySpkiB64, signatureB64: block.signatureB64 } }
}

function verifyBytes(bytes: Buffer, signed: DetachedSignature, over: string, roster: TrustedSigningKey[]): DetachedVerdict {
  let signatureOk = false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(signed.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return { state: 'malformed', note: `embedded public key is ${String(publicKey.asymmetricKeyType)} — the law is ed25519` }
    }
    signatureOk = edVerify(null, bytes, publicKey, Buffer.from(signed.signatureB64, 'base64'))
  } catch (e) {
    return { state: 'malformed', note: `embedded public key undecodable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
  }
  if (!signatureOk) {
    return { state: 'tampered', note: `signature does not verify over ${over}` }
  }
  const embeddedKeyId = keyIdOf(signed.publicKeySpkiB64)
  if (embeddedKeyId !== signed.keyId) {
    return { state: 'tampered', note: `declared keyId ${signed.keyId} does not match the embedded key (${embeddedKeyId})` }
  }
  const trusted = roster.find(k => k.publicKeySpkiB64 === signed.publicKeySpkiB64 && k.keyId === embeddedKeyId)
  if (!trusted) return { state: 'unrecognized-key', keyId: embeddedKeyId }
  return { state: 'signed', keyId: trusted.keyId, keyLabel: trusted.label }
}

export function verifyArchiveSignature(signatureText: string, archiveName: string, sha256: string, roster: TrustedSigningKey[]): DetachedVerdict {
  let value: unknown
  try {
    value = JSON.parse(signatureText)
  } catch (e) {
    return { state: 'malformed', note: `the signature file is not JSON: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
  }
  if (typeof value !== 'object' || value === null) return { state: 'malformed', note: 'the signature file is not an object' }
  const decoded = detachedSignatureOf(value, 'the signature file')
  if (decoded.state !== 'ok') return decoded
  return verifyBytes(archiveSignedBytes(archiveName, sha256), decoded.signed, "the archive's name and SHA-256", roster)
}

export function verifySignatureBlock(
  blockValue: unknown,
  binds: ContentBinds,
  roster: TrustedSigningKey[],
): SignatureVerdict {
  if (blockValue === undefined || blockValue === null) return { state: 'unsigned' }
  if (typeof blockValue !== 'object') return { state: 'malformed', note: 'manifest.signing is not an object' }
  const decoded = detachedSignatureOf(blockValue, 'signing block')
  if (decoded.state !== 'ok') return decoded
  const parsed = parseStatement(decoded.block.statement)
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

  const verdict = verifyBytes(canonicalStatementBytes(statement), decoded.signed, 'the canonical statement bytes', roster)
  return verdict.state === 'signed' || verdict.state === 'unrecognized-key' ? { ...verdict, statement } : verdict
}

export function describeSignatureVerdict(verdict: SignatureVerdict): string {
  switch (verdict.state) {
    case 'signed': {
      const lic = verdict.statement.licenseId ? ` · license-id ${verdict.statement.licenseId}` : ''
      return `signed — key ${verdict.keyId} (${verdict.keyLabel}) · ${verdict.statement.version} for ${verdict.statement.target} · packaged ${verdict.statement.packagedAt}${lic}`
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
