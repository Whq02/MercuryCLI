
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RespawnEntryResolution {
  script?: string
  direct?: boolean
  reason?: string
}

export function resolveMercuryRespawnEntry(
  override: string | undefined,
  overrideName: string,
): RespawnEntryResolution {
  if (override && override.trim().length > 0) {
    if (!existsSync(override)) {
      return { reason: `${overrideName} does not exist: ${override}` }
    }
    return { script: override, direct: true }
  }
  const self = (() => {
    try {
      return fileURLToPath(import.meta.url)
    } catch {
      return undefined
    }
  })()
  if (self && self.endsWith('.mjs') && existsSync(self)) {
    return { script: self }
  }
  const argv1 = process.argv[1]
  if (argv1 && existsSync(argv1)) {
    const base = basename(argv1)
    const looksLikeMercuryEntry =
      argv1.endsWith('.mjs') ||
      base === 'main.tsx' ||
      base === 'cli.tsx' ||
      base === 'mercury'
    if (looksLikeMercuryEntry) return { script: argv1 }
    return {
      reason: `argv[1] (${base}) is not a Mercury entry — refusing to respawn it (set ${overrideName} to override)`,
    }
  }
  return { reason: 'no runnable entry script found for the respawn' }
}
