import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { payloadDigestOf } from './installLayout.js'
import {
  describeSignatureVerdict,
  verifySignatureBlock,
  type SignatureVerdict,
} from './artifactSigning.js'
import type { InstallProvenanceKind } from './installProvenance.js'
import { trustedSigningKeys, type TrustedSigningKey } from './signingTrust.js'
import { checkVendoredRuntime, readRuntimeRecord } from './vendoredRuntime.js'

export type VerifyDepth = 'fast' | 'deep'

export interface PayloadVerification {
  verdict: SignatureVerdict
  depth: VerifyDepth
  unevaluated: string[]
  manifestVersion: string | null
}

function declaredPrimary(manifest: Record<string, unknown>): string | null {
  const rl = manifest.releaseLayout
  if (typeof rl === 'object' && rl !== null) {
    const primary = (rl as { primary?: { path?: unknown } }).primary
    if (typeof primary?.path === 'string') return primary.path
  }
  return typeof manifest.bundle === 'string' ? manifest.bundle : null
}

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

  const runtime = readRuntimeRecord(manifest)
  if (runtime?.vendored) {
    const carried = checkVendoredRuntime(dir, runtime, { digest: depth === 'deep' })
    if (carried.state !== 'ok') {
      return { verdict: { state: 'tampered', note: carried.note }, depth, unevaluated, manifestVersion }
    }
    if (depth === 'fast') unevaluated.push('vendored runtime binary digest (deep verification evaluates it)')
  }

  if (manifest.signing === undefined || manifest.signing === null) {
    return { verdict: { state: 'unsigned' }, depth, unevaluated, manifestVersion }
  }

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


export interface SignatureCheckRow {
  status: 'ok' | 'warn' | 'fail' | 'info'
  evidence: string
  fix?: string
}

export function artifactSignatureCheck(
  provenance: { kind: InstallProvenanceKind; activeRoot: string },
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
        fix: 'releases from 1.0.0-beta.3 on are signed at packaging — an unsigned payload is 1.0.0-beta.2 (shipped without the key) or a build made without it; `mercury update`, or a fresh download from github.com/Whq02/MercuryCLI/releases, brings a signed release',
      }
    case 'unrecognized-key':
      return {
        status: 'warn',
        evidence,
        fix: 'a trusted payload is signed by the Mercury release key compiled into this build (the roster in src/services/privateChannel/signingTrust.ts); one signed by another key is unattested — re-download from github.com/Whq02/MercuryCLI/releases',
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
