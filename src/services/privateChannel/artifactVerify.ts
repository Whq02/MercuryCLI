// ============================================================================
//  artifactVerify — verify one payload directory's provenance signature
//
//
//  The I/O companion to the pure artifactSigning core: read the payload's
//  manifest, recompute the content binds from REAL bytes at the requested
//  depth, and hand the pure law the facts. Consumed by three surfaces with
//  one implementation:
//    · the shipped launcher verifier (verifyArtifactStandalone.ts, built to
//      dist/verify-artifact.mjs beside the bundle);
//    · /health · doctor (healthReport's IDENTITY rows);
//    · the packager's post-sign self-check (through the built verifier).
//
//  Depth is honest, never silent: 'fast' recomputes the primary bundle's
//  sha256 and leaves the whole-payload digest UNEVALUATED (reported as
//  such); 'deep' recomputes the payloadDigest twin law over the full tree.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { payloadDigestOf } from './installLayout.js'
import {
  describeSignatureVerdict,
  verifySignatureBlock,
  type SignatureVerdict,
} from './artifactSigning.js'
import { trustedSigningKeys, type TrustedSigningKey } from './signingTrust.js'

export type VerifyDepth = 'fast' | 'deep'

export interface PayloadVerification {
  verdict: SignatureVerdict
  depth: VerifyDepth
  /** what the fast depth deliberately did not evaluate */
  unevaluated: string[]
  /** the payload manifest's version, when readable */
  manifestVersion: string | null
}

/** The primary bundle member the manifest declares (releaseLayout first,
 *  schema-2 `bundle` else), or null when the manifest declares nothing. */
function declaredPrimary(manifest: Record<string, unknown>): string | null {
  const rl = manifest.releaseLayout
  if (typeof rl === 'object' && rl !== null) {
    const primary = (rl as { primary?: { path?: unknown } }).primary
    if (typeof primary?.path === 'string') return primary.path
  }
  return typeof manifest.bundle === 'string' ? manifest.bundle : null
}

/**
 * Verify the payload at `dir`. Missing/unreadable manifests are 'malformed'
 * with the reason (a release payload always carries one — its absence beside
 * a bundle is itself evidence); a manifest without a signing block is
 * 'unsigned'. `roster` defaults to the compiled-in trust roster; provers
 * pass their ephemeral key's roster — the mechanism under test is identical.
 */
export function verifyPayloadDir(
  dir: string,
  opts: { depth?: VerifyDepth; roster?: TrustedSigningKey[] } = {},
): PayloadVerification {
  const depth: VerifyDepth = opts.depth ?? 'fast'
  const roster = opts.roster ?? trustedSigningKeys()
  const unevaluated = depth === 'fast' ? ['whole-payload digest (deep verification evaluates it)'] : []

  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return {
      verdict: { state: 'malformed', note: `no manifest.json in ${dir} — not a release payload` },
      depth,
      unevaluated,
      manifestVersion: null,
    }
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (e) {
    return {
      verdict: { state: 'malformed', note: `manifest.json unreadable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` },
      depth,
      unevaluated,
      manifestVersion: null,
    }
  }
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : null

  if (manifest.signing === undefined || manifest.signing === null) {
    return { verdict: { state: 'unsigned' }, depth, unevaluated, manifestVersion }
  }

  // Content binds from REAL bytes. The primary member comes from the
  // manifest's own declaration; a signed statement over a payload whose
  // declared primary is missing is a tamper-shaped fact, reported as such.
  const primary = declaredPrimary(manifest)
  let primarySha256: string | null = null
  if (primary !== null) {
    const primaryPath = join(dir, primary)
    if (!existsSync(primaryPath)) {
      return {
        verdict: { state: 'tampered', note: `declared primary ${primary} is absent from the payload` },
        depth,
        unevaluated,
        manifestVersion,
      }
    }
    primarySha256 = createHash('sha256').update(readFileSync(primaryPath)).digest('hex')
  }

  let payloadDigest: string | null = null
  if (depth === 'deep') {
    try {
      payloadDigest = payloadDigestOf(dir)
    } catch (e) {
      return {
        verdict: { state: 'malformed', note: `payload tree unreadable for the digest walk: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` },
        depth,
        unevaluated,
        manifestVersion,
      }
    }
  }

  const verdict = verifySignatureBlock(
    manifest.signing,
    { manifestVersion, primarySha256, payloadDigest },
    roster,
  )
  return { verdict, depth, unevaluated, manifestVersion }
}

// ── the /health row (one owner: the row's whole truth composes here so the
//    honesty prover drives the exact production wording) ─────────────────────

export interface SignatureCheckRow {
  status: 'ok' | 'warn' | 'fail' | 'info'
  evidence: string
  fix?: string
}

/** Compose the /health verdict row for the RUNNING installation. Signing
 *  enters at packaging time, so a development checkout (and an unrecognized
 *  install shape) is honest 'info', never a fabricated warn; release-shaped
 *  installs verify their payload at the requested depth. `roster` is a data
 *  seam for provers (ephemeral keys) — production passes nothing and gets
 *  the compiled roster. */
export function artifactSignatureCheck(
  provenance: { kind: 'managed' | 'extracted-release' | 'development' | 'unknown'; activeRoot: string },
  depth: VerifyDepth,
  roster?: TrustedSigningKey[],
): SignatureCheckRow {
  if (provenance.kind === 'development') {
    return {
      status: 'info',
      evidence:
        'development build — signatures are produced at packaging time (scripts/release/package.mjs); there is no release payload here to verify',
    }
  }
  if (provenance.kind === 'unknown') {
    return {
      status: 'info',
      evidence: 'installation shape unrecognized — no release payload manifest to verify a signature against',
    }
  }
  const result = verifyPayloadDir(provenance.activeRoot, { depth, roster })
  const depthNote =
    depth === 'fast'
      ? 'fast depth: primary bundle bytes bound; the deep probe evaluates the whole payload tree'
      : 'deep: whole payload tree bound to the signed digest'
  const evidence = `${describeSignatureVerdict(result.verdict)} · ${depthNote}`
  switch (result.verdict.state) {
    case 'signed':
      return { status: 'ok', evidence }
    case 'unsigned':
      return {
        status: 'warn',
        evidence,
        fix: 'expected until the operator signing ceremony is live; once releases are signed, re-download to get an attested artifact',
      }
    case 'unrecognized-key':
      return {
        status: 'warn',
        evidence,
        fix: 'a trusted artifact must be signed by a roster key (src/services/privateChannel/signingTrust.ts); treat this payload as unattested otherwise',
      }
    case 'tampered':
      return {
        status: 'fail',
        evidence,
        fix: 're-download or reinstall the release archive — the payload does not match what was signed',
      }
    case 'malformed':
      return {
        status: 'fail',
        evidence,
        fix: 'the signing block is undecodable — re-download the release archive and report it if this repeats',
      }
  }
}
