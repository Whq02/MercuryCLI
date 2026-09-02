// ============================================================================
//  utils/artifactIdentity — ONE typed artifact-identity projection
// Two builds can legitimately share a semver
//  (`1.0.0-beta.1` local vs packaged); whenever exact bytes matter the
//  distinguishing facts are buildTree + buildTime + distribution kind — this
//  module projects them ONCE from the manifest beside the running bundle
//  (the nodePolicy/ripgrep bundle-sibling idiom) so diagnostics and update
//  receipts cannot each invent their own reading. Semver semantics are
//  untouched (the R2-adjacent law: no per-rebuild version mangling).
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ArtifactIdentity {
  /** MACRO.VERSION — the product semver (never unique per rebuild). */
  version: string
  /** Where these bytes came from. */
  distribution: 'packaged-install' | 'source-build' | 'source-run'
  /** The content write-tree the bundle was built from (12-hex short). */
  buildTree: string | null
  buildTime: string | null
  /** The packaged target when the manifest declares one. */
  target: string | null
  /** The bundle entry actually running. */
  entry: string | null
}

/** Project the identity of the RUNNING artifact. Pure over (argv, disk). */
export function describeArtifactIdentity(version: string): ArtifactIdentity {
  const entry = process.argv[1] ?? null
  const base: ArtifactIdentity = {
    version,
    distribution: 'source-run',
    buildTree: null,
    buildTime: null,
    target: null,
    entry,
  }
  if (!entry || !entry.endsWith('.mjs')) return base
  const manifestPath = join(dirname(entry), 'manifest.json')
  if (!existsSync(manifestPath)) return { ...base, distribution: 'source-run' }
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      buildTree?: string
      buildTime?: string
      target?: string
    }
    // A source checkout above the bundle ⇒ a local build; otherwise the
    // bytes arrived through the install channel.
    const sourceAbove = existsSync(join(dirname(entry), '..', 'build.ts'))
    return {
      ...base,
      distribution: sourceAbove ? 'source-build' : 'packaged-install',
      buildTree: typeof m.buildTree === 'string' ? m.buildTree.slice(0, 12) : null,
      buildTime: typeof m.buildTime === 'string' ? m.buildTime : null,
      target: typeof m.target === 'string' ? m.target : null,
    }
  } catch {
    return base
  }
}

/** The concise one-line form for diagnostics/receipts. */
export function artifactIdentityLine(id: ArtifactIdentity): string {
  return [
    `v${id.version}`,
    id.distribution,
    id.buildTree ? `tree ${id.buildTree}` : null,
    id.buildTime ? `built ${id.buildTime}` : null,
    id.target ? `target ${id.target}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
