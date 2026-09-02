// ============================================================================
//  effectiveCatalogue — the ONE effective surface catalogue.
//
//  A typed derivation over the real command registry (src/commands.ts
//  builtinCommands()) — never a parallel list that can drift. Every axis a
//  projection needs is derivable here:
//    · primary name · aliases · description · kind (local-jsx/local/prompt)
//    · category (the curated /help domain map — commandDomains.ts, one source)
//    · runtime enabled/disabled (isEnabled(), evaluated LIVE per call)
//    · visibility: 'normal' | 'hidden' | 'dev' (dev = the ONE development-only
//      boundary, MERCURY_DEV_SURFACES — a devOnly route is absent from the
//      effective roster entirely unless armed)
//    · canonicalRoute (the owning journey when a name is a thin alias)
//
//  Projections that consume this instead of hand state: the /manager surface
//  index, the MERCURY_SURFACE_DUMP artifact-truth seam (src/main.tsx), and the
//  scripts/command-catalogue drift prover (which also enforces the devOnly↔gate pairing
//  and the zero-specimen law over every normal route's view sources).
// ============================================================================
import {
  COMMAND_DOMAINS,
  FALLBACK_DOMAIN_LABEL,
  groupCommandsByDomain,
} from '../components/HelpV2/commandDomains.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { type Command, getCommandName } from '../types/command.js'
import { isCommandEnabled } from './enablement.js'

/** The ONE development-only surface boundary. LIVE env read. */
export function devSurfacesEnabled(): boolean {
  return flagEnabled('MERCURY_DEV_SURFACES')
}

export type SurfaceVisibility = 'normal' | 'hidden' | 'dev'

export type EffectiveSurface = {
  /** Primary command name (the registry identity). */
  name: string
  /** User-visible name when it differs (extension prefix stripping etc.). */
  displayName: string
  aliases: readonly string[]
  description: string
  /** Command kind: 'local-jsx' (modal view) · 'local' (transcript print) · 'prompt' (model turn). */
  kind: Command['type']
  /** Curated domain key from COMMAND_DOMAINS ('other' when uncurated). */
  category: string
  categoryLabel: string
  /** isEnabled() at call time — runtime truth, distinct from maturity. */
  enabled: boolean
  visibility: SurfaceVisibility
  /** The owning route this name ultimately opens (self unless a thin alias). */
  canonicalRoute: string
}

const domainByName: Map<string, { key: string; label: string }> = (() => {
  const m = new Map<string, { key: string; label: string }>()
  for (const d of COMMAND_DOMAINS) {
    for (const n of d.names) {
      if (!m.has(n)) m.set(n, { key: d.key, label: d.label })
    }
  }
  return m
})()

function visibilityOf(cmd: Command): SurfaceVisibility {
  if (cmd.devOnly) return 'dev'
  if (cmd.isHidden) return 'hidden'
  return 'normal'
}

function toSurface(cmd: Command): EffectiveSurface {
  const domain = domainByName.get(cmd.name)
  return {
    name: cmd.name,
    displayName: getCommandName(cmd),
    aliases: cmd.aliases ?? [],
    description: cmd.description,
    kind: cmd.type,
    category: domain?.key ?? 'other',
    categoryLabel: domain?.label ?? FALLBACK_DOMAIN_LABEL,
    enabled: isCommandEnabled(cmd),
    visibility: visibilityOf(cmd),
    canonicalRoute: cmd.canonicalRoute ?? cmd.name,
  }
}

/**
 * The effective catalogue over the FULL built-in registry — every registered
 * command with live enabled state. Not memoized: enabled/visibility must track
 * env and auth changes the way getCommands() does.
 */
export function effectiveCatalogue(): EffectiveSurface[] {
  // Lazy require breaks the module cycle (commands.ts is the registry root and
  // must not statically depend on its own derivation layer's consumers).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { builtinCommands } = require('../commands.js') as typeof import('../commands.js')
  return builtinCommands().map(toSurface)
}

/**
 * The normally discoverable slice: enabled + visibility 'normal'. This is the
 * set /manager (and any browse projection) shows — identical, by construction,
 * to what typeahead//help//palette surface for built-ins (they filter the same
 * two axes at the same seams).
 */
export function normalSurfaces(): EffectiveSurface[] {
  return effectiveCatalogue().filter(
    s => s.enabled && s.visibility === 'normal',
  )
}

export type SurfaceGroup = {
  key: string
  label: string
  surfaces: EffectiveSurface[]
}

/** Category-grouped normal surfaces (COMMAND_DOMAINS order, then the rest). */
export function groupedNormalSurfaces(): SurfaceGroup[] {
  return groupCommandsByDomain(normalSurfaces()).map(g => ({
    key: g.key,
    label: g.label,
    surfaces: g.commands,
  }))
}

/**
 * The MERCURY_SURFACE_DUMP document (artifact-truth seam): one JSON object the
 * scripts/command-catalogue journey matrix reads from the BUILT artifact. Shape is part
 * of the prover contract — change both together.
 */
export function surfaceDumpDocument(): {
  generatedBy: string
  devSurfacesArmed: boolean
  surfaces: EffectiveSurface[]
} {
  return {
    generatedBy: 'effectiveCatalogue',
    devSurfacesArmed: devSurfacesEnabled(),
    surfaces: effectiveCatalogue(),
  }
}
