// ============================================================================
//  recessBackdrop — LUSTRE L1 policy: WHEN the focused-layer backdrop may
//  engage, and WHAT the recess target is for the live theme family.
//
//  The compositor executes (src/ink/recessLayer.ts — registrants + target ⇒
//  the post-compose remap); THIS module owns every gate:
//    · MERCURY_RECESS ≠ '0' (registered default-ON; `=0` restores the exact
//      pre-LUSTRE opaque claim — the modal slot re-arms its blanket opaque
//      and never registers an elevated surface);
//    · color capability — NO_COLOR sessions and 16-color families keep the
//      opaque blank claim (a named palette can't host a derived dim; blank
//      is the deterministic, hierarchical fallback);
//    · family parseability — the target derives from the resolved Mercury
//      tokens (dark: the NIGHT canvas; light: the family surface); an
//      unparseable token set (ansi:*) yields null and the gate closes.
// ============================================================================
import chalk from 'chalk'
import { CHALK_DISABLED_FOR_NO_COLOR } from '../../ink/colorize.js'
import type { RecessTransform } from '../../ink/cell-grid.js'
import type { MercuryThemeTokens } from '../mercuryTokens.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

function parseHex(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

/** The flag + capability gate (family capability is the target's own job —
 *  see recessTargetFor). */
export function recessBackdropEnabled(): boolean {
  if (flagEnv('MERCURY_RECESS') === '0') return false
  if (CHALK_DISABLED_FOR_NO_COLOR) return false
  return chalk.level >= 2
}

/** The recess target for the resolved tokens — null when the family can't
 *  host a derived dim (ansi:* names) or the gate is closed. Dark families
 *  fold toward their painted canvas; light families fold toward their own
 *  surface (receding on paper is a lift toward it, same math). */
export function recessTargetFor(tokens: MercuryThemeTokens): RecessTransform | null {
  if (!recessBackdropEnabled()) return null
  const canvas = parseHex(tokens.canvas) ?? parseHex(tokens.surface0)
  const ink = parseHex(tokens.textPrimary)
  if (!canvas || !ink) return null
  return { canvas, ink, quantize256: chalk.level === 2 }
}
