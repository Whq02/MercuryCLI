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

// ============================================================================
// commands/accent/accent.ts — `/accent [name|#hex|reset]` (QoL program).
//
// "Colour the REPL": a live, session-only override of the identity accent —
// frame, wordmark, sigil, prompt caret, panel borders all re-tint synchronously
// via the sessionAccent observable (the same live path /critter uses). An
// explicit pick outranks the derived tints (critter hue / fable recolor);
// `/accent reset` restores the derivation chain. Named swatches map
// to EXISTING tokens only (mercuryPalette + the critter hues) — zero new hex in
// source; an arbitrary #hex is operator runtime input, not a source literal.
// ============================================================================

// Named swatches — every value is an imported token, never a literal.
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
  // ('dragon' removed with the retired critter. /accent
  //  now offers exactly the four pool hues plus the fixed named colours.)
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
        ? `accent override cleared — back to the derived chain (critter/fable): now ${getSessionAccent().accent}`
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
