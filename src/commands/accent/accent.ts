import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { AMBER, CRIMSON, OASIS, TEAL, TERRA } from '../../components/mercuryPalette.js'
import {
  CRITTERS,
  getSessionAccent,
  getSessionAccentOverride,
  setSessionAccentOverride,
} from '../../components/mercury-ui/sessionAccent.js'


const NAMED: Record<string, string> = {
  terra: TERRA,
  teal: TEAL,
  amber: AMBER,
  oasis: OASIS,
  crimson: CRIMSON,
  crab: CRITTERS.crab!.accent,
  octopus: CRITTERS.octopus!.accent,
  jellyfish: CRITTERS.jellyfish!.accent,
  clam: CRITTERS.clam!.accent,
}

export const call = async (
  rawArg: string,
  _context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const arg = rawArg.trim().toLowerCase()

  if (arg === '' ) {
    const cur = getSessionAccent()
    const overridden = getSessionAccentOverride() !== null
    return {
      type: 'text',
      value:
        `accent ${cur.accent}${overridden ? ' (operator override)' : ` (${cur.name} — derived)`}\n` +
        `usage: /accent <name|#hex|reset> — session-only, re-tints the whole identity chrome live\n` +
        `names: ${Object.keys(NAMED).join(' · ')}`,
    }
  }

  if (arg === 'reset' || arg === 'default' || arg === 'off') {
    const changed = setSessionAccentOverride(null)
    return {
      type: 'text',
      value: changed
        ? `accent override cleared — back to the derived chain (critter/scribe/fable): now ${getSessionAccent().accent}`
        : 'no accent override was active',
    }
  }

  const hex = NAMED[arg] ?? arg
  const ok = setSessionAccentOverride(hex)
  if (!ok) {
    return {
      type: 'text',
      value: `not a colour I can use: '${rawArg.trim()}' — try a name (${Object.keys(NAMED).join(' · ')}) or #RRGGBB`,
    }
  }
  return {
    type: 'text',
    value: `accent → ${getSessionAccent().accent}${NAMED[arg] ? ` (${arg})` : ''} — session-only · /accent reset restores the critter accent`,
  }
}
