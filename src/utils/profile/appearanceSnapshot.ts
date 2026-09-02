
import chalk from 'chalk'
import { getSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { getGlobalConfig } from '../config.js'
import { getInitialSettings } from '../settings/settings.js'
import { resolveThemeSetting } from '../systemTheme.js'
import type { ThemeName, ThemeSetting } from '../theme.js'

export type TerminalColorMode = 'truecolor' | '256' | '16' | 'mono'

export type MercuryAppearanceSnapshot = {
  requestedTheme: ThemeSetting
  concreteTheme: ThemeName
  colorMode: TerminalColorMode
  accent: string
  motion: 'full' | 'reduced'
  changedAt: number
}

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
