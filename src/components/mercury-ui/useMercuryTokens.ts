// ============================================================================
//  useMercuryTokens — the live React selector over the adaptive token layer
// Subscribes to the resolved theme (never 'auto') and
//  the session accent (critter pick · /accent override · fable recolor — the
//  unified derivation) so an /appearance or /critter change re-resolves tokens in
//  place; memoized per (concrete family × accent) inside the resolver, so
//  renders share one frozen object.
// ============================================================================

import { useTheme } from '../../ink.js'
import {
  type MercuryThemeTokens,
  resolveMercuryTokens,
} from '../../utils/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'

export function useMercuryTokens(): MercuryThemeTokens {
  const [currentTheme] = useTheme()
  const accent = useSessionAccent().accent
  return resolveMercuryTokens(currentTheme, accent)
}
