import { writeSync } from 'fs'
import { groundFamilyFor, NIGHT } from '../theme/mercuryPalette.js'
import { launcherHeldAtBoot } from '../renderer/launcherAltHold.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { isDarkThemeFamily } from '../theme/mercuryTokens.js'
import { DEFAULT_THEME_SETTING, resolveThemeSetting } from '../theme/systemTheme.js'
import type { ThemeName } from '../theme/theme.js'
import { flagEnabled, flagEnv } from '../../platform/substrate/flagRegistry.js'
import { shouldHonorNoColor, truecolorFingerprint } from '../renderer/colorize.js'
import { parseOscColor } from '../renderer/termio/osc.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

function concreteTheme(): ThemeName {
  try {
    return resolveThemeSetting(getGlobalConfig().theme)
  } catch {
    return DEFAULT_THEME_SETTING
  }
}

export function oasisBgEnabled(
  isTTY: boolean = Boolean(process.stdout.isTTY),
  theme: ThemeName = concreteTheme(),
): boolean {
  if (!flagEnabled('MERCURY_OASIS_BG')) return false
  if (!isTTY || shouldHonorNoColor()) return false
  if (/^(dumb|linux)$/.test(hostEnv().TERM || '')) return false
  if (!isDarkThemeFamily(theme)) return false
  return true
}

export function oasisBgEnter(theme: ThemeName = DEFAULT_THEME_SETTING): string {
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

export type TerminalGround =
  | { state: 'painted'; color: string }
  | { state: 'original'; color: string }
  | { state: 'unknown' }

const groundListeners = new Set<() => void>()

function groundChanged(): void {
  for (const listener of groundListeners) listener()
}

export function subscribeTerminalGround(listener: () => void): () => void {
  groundListeners.add(listener)
  return () => {
    groundListeners.delete(listener)
  }
}

function groundHex(spec: string): string | null {
  const color = parseOscColor(spec)
  if (color === null || color.type !== 'rgb') return null
  const channel = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

export function terminalGround(): TerminalGround {
  if (painted && paintedSpec !== undefined) {
    const color = groundHex(paintedSpec)
    return color === null ? { state: 'unknown' } : { state: 'painted', color }
  }
  if (!painted && exactOriginal !== undefined) {
    const color = groundHex(exactOriginal)
    return color === null ? { state: 'unknown' } : { state: 'original', color }
  }
  return { state: 'unknown' }
}

export function markOriginalGroundQuerySent(): void {
  paintedAtQuerySend = painted
}

export function noteOriginalGroundReply(
  spec: string,
  write: (s: string) => void = s => process.stdout.write(s),
): void {
  if (!spec || shouldHonorNoColor() || /^(dumb|linux)$/.test(hostEnv().TERM || '') || concreteTheme() === 'mono') return
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
  groundChanged()
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
      groundChanged()
    } else if (paintedBy === 'oasis' && paintedSpec !== spec) {
      paintedSpec = spec
      write(oasisBgSet(spec))
      groundChanged()
    }
  } else if (painted && paintedBy === 'oasis') {
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    write(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
    groundChanged()
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
      } catch (error) {
        passedOver(error)
      }
    })
  if (painted) {
    exitRestored = true
    painted = false
    paintedBy = null
    paintedSpec = undefined
    channelHealed = true
    w(exactOriginal !== undefined ? oasisBgSet(exactOriginal) : oasisBgExit())
    groundChanged()
  } else if (launcherHeldAtBoot() && !channelHealed && splashCouldHaveRecoloured()) {
    exitRestored = true
    w(oasisBgExit())
  }
}

function splashCouldHaveRecoloured(): boolean {
  if (!flagEnabled('MERCURY_OASIS_BG')) return false
  const depth = flagEnv('MERCURY_TRUECOLOR')
  if (depth === '0') return false
  if (/^(dumb|linux)$/.test(hostEnv().TERM || '')) return false
  const noColor = hostEnv().NO_COLOR
  const forceColor = hostEnv().FORCE_COLOR
  if (noColor && noColor.length > 0 && !(forceColor && forceColor.length > 0)) return false
  return isEnvTruthy(depth) || truecolorFingerprint(hostEnv()) !== null
}

export function _resetGroundForTest(): void {
  painted = false
  paintedBy = null
  paintedSpec = undefined
  exactOriginal = undefined
  paintedAtQuerySend = undefined
  exitRestored = false
  channelHealed = false
  groundChanged()
}
