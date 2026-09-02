import {
  COMMAND_DOMAINS,
  FALLBACK_DOMAIN_LABEL,
  groupCommandsByDomain,
} from '../components/HelpV2/commandDomains.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { type Command, getCommandName } from '../types/command.js'
import { isCommandEnabled } from './enablement.js'

export function devSurfacesEnabled(): boolean {
  return flagEnabled('MERCURY_DEV_SURFACES')
}

export type SurfaceVisibility = 'normal' | 'hidden' | 'dev'

export type EffectiveSurface = {
  name: string
  displayName: string
  aliases: readonly string[]
  description: string
  kind: Command['type']
  category: string
  categoryLabel: string
  enabled: boolean
  visibility: SurfaceVisibility
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

export function effectiveCatalogue(): EffectiveSurface[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { builtinCommands } = require('../commands.js') as typeof import('../commands.js')
  return builtinCommands().map(toSurface)
}

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

export function groupedNormalSurfaces(): SurfaceGroup[] {
  return groupCommandsByDomain(normalSurfaces()).map(g => ({
    key: g.key,
    label: g.label,
    surfaces: g.commands,
  }))
}

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
