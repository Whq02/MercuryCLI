#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-artifact-signing.ts — LANE LW deliverable 1: the
//  Ed25519 artifact-signing law (round-trip + the tamper red-path).
//
//  Ephemeral keypairs ONLY (the key-custody constraint): every key here is
//  generated in-memory per run and dies with the process — no private key
//  material is ever written to the repo, the config estate, or a fixture.
//
//  Fixtures build through the ONE member-role authority
//  (scripts/release/payloadContract.mjs) exactly like the packager, so a
//  fixture that drifts from the shipped archive shape cannot exist (U2).
//
//  Also the ceremony helper: `--key-id <spki-b64>` prints the keyId the
//  roster entry needs (see src/services/privateChannel/signingTrust.ts).
// ============================================================================
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalStatementBytes,
  keyIdOf,
  parseStatement,
  signStatement,
  verifySignatureBlock,
  type SigningStatementV1,
} from '../../src/services/privateChannel/artifactSigning.js'
import { verifyPayloadDir } from '../../src/services/privateChannel/artifactVerify.js'
import type { TrustedSigningKey } from '../../src/services/privateChannel/signingTrust.js'
// @ts-expect-error — the packager-side authority is plain .mjs (no types); the
// fixture MUST build through it (payloadContract U2: one member-role owner).
import { readCompatFloor, releaseLayoutSection } from '../release/payloadContract.mjs'

// ── the ceremony helper (not a proof leg) ───────────────────────────────────
{
  const i = process.argv.indexOf('--key-id')
  if (i !== -1) {
    const b64 = process.argv[i + 1]
    if (!b64) {
      console.error('usage: prove-artifact-signing.ts --key-id <spki-der-base64>')
      process.exit(2)
    }
    console.log(keyIdOf(b64))
    process.exit(0)
  }
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('artifact signing — round-trip + tamper red-path (ephemeral keys)')

const SCRATCH = mkdtempSync(join(tmpdir(), 'artifact-signing-'))

// One ephemeral pair for the whole run; a SECOND pair plays the stranger.
const pair = generateKeyPairSync('ed25519')
const stranger = generateKeyPairSync('ed25519')
const pemOf = (p: typeof pair): string => p.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const rosterOf = (p: typeof pair, label: string): TrustedSigningKey => {
  const spki = p.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { keyId: keyIdOf(spki), publicKeySpkiB64: spki, label }
}
const roster = [rosterOf(pair, 'ephemeral prover key')]

/** A release-shaped fixture payload built through the packager's own
 *  authority, signed (or not) with the ephemeral key. */
function buildFixturePayload(name: string, opts: { sign?: boolean; licenseId?: string | null } = {}): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mercury.mjs'), `// fixture bundle ${name}\nconsole.log('mercury fixture')\n`)
  writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexit 0\n')
  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: '9.9.9-beta.1',
    buildTree: 'f'.repeat(40),
    bundle: 'mercury.mjs',
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const rl = releaseLayoutSection(dir, 'macos-arm64', readCompatFloor()) as {
    primary: { sha256: string }
    payloadDigest: string
  }
  manifest.releaseLayout = rl
  if (opts.sign !== false) {
    const statement: SigningStatementV1 = {
      schema: 1,
      name: 'mercury',
      version: '9.9.9-beta.1',
      channel: 'private',
      target: 'macos-arm64',
      packagedAt: '2026-08-22T00:00:00.000Z',
      buildTree: 'f'.repeat(40),
      primarySha256: rl.primary.sha256,
      payloadDigest: rl.payloadDigest,
      licenseId: opts.licenseId ?? null,
    }
    manifest.signing = signStatement(statement, pemOf(pair))
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return dir
}

try {
  // ── canonicalization law: pinned bytes ──────────────────────────────────
  const stmt: SigningStatementV1 = {
    schema: 1,
    name: 'mercury',
    version: '1.2.3-beta.4',
    channel: 'private',
    target: 'linux-x64',
    packagedAt: '2026-08-22T01:02:03.000Z',
    buildTree: null,
    primarySha256: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    licenseId: 'LIC-42',
  }
  const expectCanonical =
    '{"schema":1,"name":"mercury","version":"1.2.3-beta.4","channel":"private","target":"linux-x64","packagedAt":"2026-08-22T01:02:03.000Z","buildTree":null,"primarySha256":"' +
    'a'.repeat(64) +
    '","payloadDigest":"' +
    'b'.repeat(64) +
    '","licenseId":"LIC-42"}'
  check('canonical statement bytes are the pinned key-order JSON', canonicalStatementBytes(stmt).toString('utf8') === expectCanonical)
  check(
    'statement parser refuses an unknown key (it would escape the signature)',
    parseStatement({ ...stmt, extra: 1 }).state === 'malformed',
  )
  check('statement parser refuses a non-hex digest', parseStatement({ ...stmt, payloadDigest: 'z'.repeat(64) }).state === 'malformed')

  // ── pure round-trip ─────────────────────────────────────────────────────
  const block = signStatement(stmt, pemOf(pair))
  check('sign → verify round-trips to signed under the ephemeral roster', verifySignatureBlock(block, { manifestVersion: stmt.version, primarySha256: stmt.primarySha256, payloadDigest: stmt.payloadDigest }, roster).state === 'signed')
  check('keyId law: block.keyId = sha256(spki)[:16]', block.keyId === keyIdOf(block.publicKeySpkiB64) && block.keyId.length === 16)
  check('licenseId rides inside the signed statement (the attribution seam)', block.statement.licenseId === 'LIC-42')
  check(
    'a non-ed25519 key is refused at signing time',
    (() => {
      try {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
        signStatement(stmt, rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
        return false
      } catch {
        return true
      }
    })(),
  )

  // ── the tamper red-path (pure layer) ────────────────────────────────────
  const flippedSig = { ...block, signatureB64: Buffer.from(Buffer.from(block.signatureB64, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') }
  check('a flipped signature bit is tampered', verifySignatureBlock(flippedSig, { manifestVersion: null, primarySha256: null, payloadDigest: null }, roster).state === 'tampered')
  const editedStatement = { ...block, statement: { ...block.statement, version: '9.9.9-beta.9' } }
  check('an edited statement no longer verifies (tampered)', verifySignatureBlock(editedStatement, { manifestVersion: null, primarySha256: null, payloadDigest: null }, roster).state === 'tampered')
  check('a bundle-hash mismatch is tampered with the named bind', (() => {
    const v = verifySignatureBlock(block, { manifestVersion: stmt.version, primarySha256: 'c'.repeat(64), payloadDigest: null }, roster)
    return v.state === 'tampered' && v.note.includes('primary bundle bytes differ')
  })())
  const strangerBlock = signStatement(stmt, pemOf(stranger))
  check('a VALID signature under an un-rostered key is unrecognized-key, never signed', verifySignatureBlock(strangerBlock, { manifestVersion: null, primarySha256: null, payloadDigest: null }, roster).state === 'unrecognized-key')
  check('re-signed-by-stranger block with stranger key in roster IS signed (trust is the roster, not the artifact)', verifySignatureBlock(strangerBlock, { manifestVersion: null, primarySha256: null, payloadDigest: null }, [rosterOf(stranger, 'stranger')]).state === 'signed')
  check('absent block is unsigned', verifySignatureBlock(undefined, { manifestVersion: null, primarySha256: null, payloadDigest: null }, roster).state === 'unsigned')
  check('keyId spoof (declared ≠ embedded) is tampered', verifySignatureBlock({ ...block, keyId: '0'.repeat(16) }, { manifestVersion: null, primarySha256: null, payloadDigest: null }, roster).state === 'tampered')

  // ── payload round-trip through the REAL verify path ─────────────────────
  const signedDir = buildFixturePayload('signed')
  check('fixture payload verifies signed at fast depth', verifyPayloadDir(signedDir, { depth: 'fast', roster }).verdict.state === 'signed')
  check('fixture payload verifies signed at deep depth', verifyPayloadDir(signedDir, { depth: 'deep', roster }).verdict.state === 'signed')
  check('fast depth names the unevaluated payload digest honestly', verifyPayloadDir(signedDir, { depth: 'fast', roster }).unevaluated.length === 1)
  check('the compiled (empty-production) roster reports unrecognized-key for the ephemeral signature', verifyPayloadDir(signedDir, { depth: 'fast' }).verdict.state === 'unrecognized-key')

  // tamper the primary bundle → fast depth catches it (primary hash bind)
  const tamperedBundle = buildFixturePayload('tampered-bundle')
  writeFileSync(join(tamperedBundle, 'mercury.mjs'), '// tampered bytes\n')
  check('a tampered primary bundle is tampered at FAST depth', verifyPayloadDir(tamperedBundle, { depth: 'fast', roster }).verdict.state === 'tampered')

  // tamper a NON-primary member → fast misses it BY DESIGN, deep catches it
  const tamperedMember = buildFixturePayload('tampered-member')
  writeFileSync(join(tamperedMember, 'mercury'), '#!/bin/sh\nrm -rf /somewhere-else\n')
  check('a tampered non-primary member passes fast (the stated depth limit)', verifyPayloadDir(tamperedMember, { depth: 'fast', roster }).verdict.state === 'signed')
  check('a tampered non-primary member is TAMPERED at deep depth', verifyPayloadDir(tamperedMember, { depth: 'deep', roster }).verdict.state === 'tampered')

  // an edited license-id (delivery attribution) breaks the signature
  const editedLicense = buildFixturePayload('edited-license', { licenseId: 'LIC-A' })
  {
    const m = JSON.parse(readFileSync(join(editedLicense, 'manifest.json'), 'utf8')) as { signing: { statement: { licenseId: string } } }
    m.signing.statement.licenseId = 'LIC-B'
    writeFileSync(join(editedLicense, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
    check('an edited licenseId is tampered (the seam is signature-covered)', verifyPayloadDir(editedLicense, { depth: 'fast', roster }).verdict.state === 'tampered')
  }

  const unsignedDir = buildFixturePayload('unsigned', { sign: false })
  check('an unsigned payload is unsigned (a fact, not an error)', verifyPayloadDir(unsignedDir, { depth: 'deep', roster }).verdict.state === 'unsigned')
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-artifact-signing: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-artifact-signing: all green')
