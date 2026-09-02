// ============================================================================
//  artifactSigning — the PURE core of Mercury artifact provenance signatures
//
//
//  Zero I/O by construction (the channelCore discipline): the statement
//  grammar, its canonical byte form, Ed25519 sign/verify over those bytes,
//  and the verification verdict law all live here so every consumer — the
//  packager (scripts/release/package.mjs, through the BUILT
//  dist/verify-artifact.mjs), the shipped launcher verifier, /health and the
//  provers — decides identically from one implementation. File reads, payload
//  walks and provenance lookups live in artifactVerify.ts.
//
//  WHAT IS SIGNED: the release-manifest tuple, bound to bytes —
//    version · channel · platform target · packaging date · source tree ·
//    primary-bundle sha256 · whole-payload digest · license id (the
//    delivery-time attribution seam; semantics land later, the field is
//    covered by the signature NOW so it can never be edited unsigned).
//  The signature block lives INSIDE manifest.json, which the whole-payload
//  digest law excludes by construction (payloadContract L20) — signing the
//  payloadDigest therefore covers every shipped byte except the manifest,
//  and the manifest's own claims are covered by the signature itself.
//
//  Provenance is EVIDENCE, never prevention (the lane mandate): a stripped
//  or re-signed artifact is reported plainly ('unsigned' /
//  'unrecognized-key'), and no verifier refuses to run anything.
// ============================================================================
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto'
import type { TrustedSigningKey } from './signingTrust.js'

/** The signed statement (schema 1). Field ORDER here is the canonical wire
 *  order — canonicalStatementBytes serializes exactly these keys in exactly
 *  this sequence, so two implementations can never disagree on bytes. */
export interface SigningStatementV1 {
  schema: 1
  /** artifact family — the build manifest's `name` ('mercury') */
  name: string
  /** release version (package.json form, e.g. 1.0.0-beta.1) */
  version: string
  /** the release channel this artifact ships through ('private') */
  channel: string
  /** platform target (linux-x64 | macos-arm64 | macos-x64 | windows-x64) */
  target: string
  /** ISO-8601 packaging instant */
  packagedAt: string
  /** the build's source-tree object id (manifest.buildTree; null = no git) */
  buildTree: string | null
  /** sha256 of the primary runtime bundle's bytes (releaseLayout.primary) */
  primarySha256: string
  /** the whole-payload digest (payloadContract/installLayout twin law) */
  payloadDigest: string
  /** delivery-time license attribution seam — null until semantics land */
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

/** Parse an unknown value as a schema-1 statement — every field type-checked,
 *  unknown keys refused (an unknown key would silently escape the canonical
 *  byte form and therefore the signature). */
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

/** THE canonical byte form: JSON with the schema-1 key order pinned above,
 *  no whitespace, UTF-8. Signatures are over exactly these bytes. */
export function canonicalStatementBytes(statement: SigningStatementV1): Buffer {
  const ordered: Record<string, unknown> = {}
  for (const key of STATEMENT_KEYS) ordered[key] = statement[key]
  return Buffer.from(JSON.stringify(ordered), 'utf8')
}

/** keyId law: sha256 over the SPKI DER public-key bytes, first 16 hex. */
export function keyIdOf(publicKeySpkiB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeySpkiB64, 'base64')).digest('hex').slice(0, 16)
}

/** The manifest-resident signature block (manifest.signing, schema 1). */
export interface SignatureBlockV1 {
  schema: 1
  algorithm: 'ed25519'
  keyId: string
  /** base64 SPKI DER — carried for transparency and keyId display; TRUST
   *  comes only from the compiled-in roster, never from this field. */
  publicKeySpkiB64: string
  statement: SigningStatementV1
  /** base64 Ed25519 signature over canonicalStatementBytes(statement) */
  signatureB64: string
}

/** Sign a statement with an Ed25519 private key (PKCS#8 PEM). Used by the
 *  packager at packaging time and by provers with EPHEMERAL keypairs only —
 *  the production private key is operator-held and never enters the repo. */
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

/** What verification concluded — every state is a plain, distinct fact
 *  (law 1): 'signed' only on a valid signature under a ROSTER key with every
 *  provided content bind matching; anything else names exactly what failed. */
export type SignatureVerdict =
  | { state: 'signed'; keyId: string; keyLabel: string; statement: SigningStatementV1 }
  | { state: 'unsigned' }
  | { state: 'unrecognized-key'; keyId: string; statement: SigningStatementV1 }
  | { state: 'tampered'; note: string }
  | { state: 'malformed'; note: string }

/** The content facts a caller recomputed from REAL bytes. null = this bind
 *  was not evaluated at this verification depth (never a silent pass — the
 *  callers state their depth). */
export interface ContentBinds {
  /** the manifest's own version field (statement must agree) */
  manifestVersion: string | null
  /** sha256 recomputed over the primary bundle's actual bytes */
  primarySha256: string | null
  /** payload digest recomputed over the actual payload tree (deep only) */
  payloadDigest: string | null
}

/**
 * THE verification law. Order: decode → content binds (does reality match
 * the statement?) → signature (is the statement authentic under its own
 * embedded key?) → trust (is that key in the roster?). Content mismatches
 * and signature failures are both 'tampered' with distinct notes; a valid
 * signature under an un-rostered key is 'unrecognized-key', never 'signed'.
 */
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

/** One display line per verdict — the shared vocabulary of the launcher
 *  verifier, /health and doctor, so every surface states the same plain fact. */
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
