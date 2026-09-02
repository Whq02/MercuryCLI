import { writeSync } from 'fs'
import { groundFamilyFor, NIGHT } from '../../components/mercuryPalette.js'
import { launcherHeldAtBoot } from '../../ink/launcherAltHold.js'
import { getGlobalConfig } from '../config.js'
import { isDarkThemeFamily } from '../mercuryTokens.js'
import { resolveThemeSetting } from '../systemTheme.js'
import type { ThemeName } from '../theme.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

function concreteTheme(): ThemeName {
  try {
    return resolveThemeSetting(getGlobalConfig().theme)
  } catch {
    return 'dark'
  }
}

export function oasisBgEnabled(
  isTTY: boolean = Boolean(process.stdout.isTTY),
  theme: ThemeName = concreteTheme(),
): boolean {
  if (flagEnv('MERCURY_OASIS_BG') === '0') return false
  if (!isTTY) return false
  if (/^(dumb|linux)$/.test(process.env.TERM || '')) return false
  if (!isDarkThemeFamily(theme)) return false
  return true
}

export function oasisBgEnter(theme: ThemeName = 'dark'): string {
  return `\x1b]11;${groundFamilyFor(theme).NIGHT}\x07`
}

export function oasisBgExit(): string {
  return `\x1b]111\x07`
}

function oasisBgSet(spec: string): string {
  return `\x1b]11;${spec}\x07`
}

let painted = false
let paintedSpec: string | undefined
let paintedBy: 'oasis' | 'warm' | null = null
let exactOriginal: string | undefined
let paintedAtQuerySend: boolean | undefined
let exitRestored = false
let channelHealed = false

export function markOriginalGroundQuerySent(): void {
  paintedAtQuerySend = painted
}

export function noteOriginalGroundReply(
  spec: string,
  write: (s: string) => void = s => process.stdout.write(s),
): void {
  if (!spec) return
  if (paintedAtQuerySend !== false) return
  if (exactOriginal === undefined && !launcherHeldAtBoot()) {
    exactOriginal = spec
  }
  if (!painted) {
    painted = true
    paintedBy = 'warm'
    paintedSpec = NIGHT
    write(oasisBgSet(NIGHT))
  }
}

export function syncOasisBgToTheme(
  theme: ThemeName,
  write: (s: string) => void = s => process.stdout.write(s),
): void {
  if (isDarkThemeFamily(theme)) {
    if (!oasisBgEnabled(Boolean(process.stdout.isTTY), theme)) return
    const spec = groundFamilyFor(theme).NIGHT
    if (!painted) {
      painted = true
      paintedBy = 'oasis'
      paintedSpec = spec
      write(oasisBgSet(spec))
    } else if (paintedBy === 'oasis' && paintedSpec !== spec) {
      paintedSpec = spec
      write(oasisBgSet(spec))
    }
  } else if (painted && paintedBy === 'oasis') {
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    write(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
  }
}

export function exitOasisBg(write?: (s: string) => void): void {
  if (exitRestored) return
  const w =
    write ??
    ((s: string) => {
      try {
        if (process.stdout.isTTY) writeSync(1, s)
        else if (process.stderr.isTTY) writeSync(2, s)
      } catch {
      }
    })
  if (painted) {
    exitRestored = true
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    w(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
  } else if (launcherHeldAtBoot() && !channelHealed && splashCouldHaveRecoloured()) {
    exitRestored = true
    w(oasisBgExit())
  }
}

function splashCouldHaveRecoloured(): boolean {
  if (flagEnv('MERCURY_OASIS_BG') === '0') return false
  if (flagEnv('MERCURY_TRUECOLOR') === '0') return false
  if (/^(dumb|linux)$/.test(process.env.TERM || '')) return false
  const noColor = process.env.NO_COLOR
  const forceColor = process.env.FORCE_COLOR
  if (noColor && noColor.length > 0 && !(forceColor && forceColor.length > 0)) return false
  return true
}

export function _resetGroundForTest(): void {
  painted = false
  paintedBy = null
  paintedSpec = undefined
  exactOriginal = undefined
  paintedAtQuerySend = undefined
  exitRestored = false
  channelHealed = false
}
