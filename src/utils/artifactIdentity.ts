import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ArtifactIdentity {
  version: string
  distribution: 'packaged-install' | 'source-build' | 'source-run'
  buildTree: string | null
  buildTime: string | null
  target: string | null
  entry: string | null
}

export function realEntryPath(entry: string | null): string | null {
  if (entry === null || entry === '') return entry
  try {
    return realpathSync(entry)
  } catch {
    return entry
  }
}

export function describeArtifactIdentity(version: string): ArtifactIdentity {
  const entry = realEntryPath(process.argv[1] ?? null)
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
