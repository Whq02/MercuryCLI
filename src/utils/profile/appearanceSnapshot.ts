// ============================================================================
//  MercuryAppearanceSnapshot — the typed APPEARANCE half of the session
//  profile: what theme the operator asked for, what concretely resolved, what
//  the terminal can actually render, and which identity accent is live.
// ----------------------------------------------------------------------------
//  Pure resolver over the EXISTING owners (config theme setting, the
//  systemTheme auto-resolution, chalk's color level, the session-accent
//  store) — no new state. Surfaces that explain appearance (doctor, the
//  appearance center, receipts) consume the snapshot instead of re-deriving.
// ============================================================================

import chalk from 'chalk'
import { getSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { getGlobalConfig } from '../config.js'
import { getInitialSettings } from '../settings/settings.js'
import { resolveThemeSetting } from '../systemTheme.js'
import type { ThemeName, ThemeSetting } from '../theme.js'

/** What the terminal is actually capable of rendering (chalk level). */
export type TerminalColorMode = 'truecolor' | '256' | '16' | 'mono'

export type MercuryAppearanceSnapshot = {
  /** The stored preference — may be 'auto'. */
  requestedTheme: ThemeSetting
  /** What 'auto' (or the explicit pick) concretely resolved to. */
  concreteTheme: ThemeName
  colorMode: TerminalColorMode
  /** The live identity accent hex (critter/session accent, post-recolor). */
  accent: string
  /** Decorative-animation posture (prefersReducedMotion; frame-0 static
   *  degradation keeps progress semantics visible either way). */
  motion: 'full' | 'reduced'
  changedAt: number
}

/** Chalk color level → the operator-readable capability name. */
export function colorModeFromLevel(level: 0 | 1 | 2 | 3): TerminalColorMode {
  switch (level) {
    case 3:
      return 'truecolor'
    case 2:
      return '256'
    case 1:
      return '16'
    default:
      return 'mono'
  }
}

export type AppearanceResolveInputs = {
  requestedTheme: ThemeSetting
  concreteTheme: ThemeName
  colorLevel: 0 | 1 | 2 | 3
  accent: string
  reducedMotion: boolean
  changedAt: number
}

/** Pure resolver — same inputs ⇒ an equal, frozen snapshot. */
export function resolveMercuryAppearance(
  i: AppearanceResolveInputs,
): MercuryAppearanceSnapshot {
  return Object.freeze({
    requestedTheme: i.requestedTheme,
    concreteTheme: i.concreteTheme,
    colorMode: colorModeFromLevel(i.colorLevel),
    accent: i.accent,
    motion: i.reducedMotion ? ('reduced' as const) : ('full' as const),
    changedAt: i.changedAt,
  })
}

/** Gather the live inputs from their owners and resolve. */
export function getMercuryAppearanceSnapshot(
  changedAt = 0,
): MercuryAppearanceSnapshot {
  const requestedTheme = getGlobalConfig().theme
  return resolveMercuryAppearance({
    requestedTheme,
    concreteTheme: resolveThemeSetting(requestedTheme),
    colorLevel: (chalk.level ?? 0) as 0 | 1 | 2 | 3,
    accent: getSessionAccent().accent,
    reducedMotion: getInitialSettings().prefersReducedMotion ?? false,
    changedAt,
  })
}
