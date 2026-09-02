// respawnEntry — resolve the script a Mercury self-respawn should execute.
//
// Extracted VERBATIM from builtinServers.sidecarEntryScript so
// every IDE-hands lane that respawns the running bundle as a helper process
// (the mercury-ts sidecar via `--lsp-ts-sidecar`, the tcp bridge via
// `--mercury-tcp-bridge`) shares ONE resolution contract, most-certain first:
//   1. An explicit override (operator/test env) — spawned DIRECTLY; the
//      target file's direct-exec guard handles it.
//   2. The BUNDLE ITSELF via this module's import.meta.url — when Mercury
//      runs from dist, this module lives inside mercury.mjs, which carries
//      every cli fast-path route by construction.
//   3. process.argv[1] — ONLY when it looks like a Mercury entry that owns
//      the cli routes (main/cli source entry or a .mjs bundle). An arbitrary
//      argv[1] (a proof script, an embedder) must NOT be respawned: it would
//      re-execute the host script with the route flag, hang the caller for
//      its whole startupTimeout, and burn the restart budget — exactly the
//      failure scripts/lsp/prove-lsp-manager-integration.ts reproduces.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RespawnEntryResolution {
  script?: string
  /** True when script is the helper module itself (spawn WITHOUT the cli route flag). */
  direct?: boolean
  reason?: string
}

/**
 * @param override explicit entry-script override (the lane's *_ENTRY env),
 *   spawned directly when set
 * @param overrideName the env var's name, for the honest missing-file reason
 */
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
    // Running from the single-file bundle — respawn it.
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
