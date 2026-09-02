
import { truecolorActive } from '../ink/colorize.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  AMBER,
  BELLY,
  CRIMSON,
  DIFF_ADD_BG,
  DIFF_ADD_WORD,
  DIFF_DEL_BG,
  DIFF_DEL_WORD,
  DUNE,
  DUNE_FAINT,
  FAINT,
  groundFamilyFor,
  IVORY,
  NIGHT,
  OASIS,
  SECOND,
  TEAL,
  TERRA,
} from '../components/mercuryPalette.js'
import { getTheme, type Theme, type ThemeName } from './theme.js'

function parseColor(c: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)]
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c.trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

export function deriveAccentSoft(accent: string, primaryInk: string): string {
  const a = parseColor(accent)
  const ink = parseColor(primaryInk)
  if (!a || !ink) return accent
  const mix = (x: number, y: number): string =>
    Math.round(x + (y - x) * 0.4)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(a[0], ink[0])}${mix(a[1], ink[1])}${mix(a[2], ink[2])}`
}

export function deriveFocalRamp(
  accent: string,
  accentSoft: string,
  primaryInk: string,
): string[] {
  const a = parseColor(accent)
  const ink = parseColor(primaryInk)
  if (!a || !ink) return [accent]
  const walk = (x: number, y: number): string =>
    Math.round(x + (y - x) * 0.7)
      .toString(16)
      .padStart(2, '0')
  return [accent, accentSoft, `#${walk(a[0], ink[0])}${walk(a[1], ink[1])}${walk(a[2], ink[2])}`]
}

function chan(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return null
  const la = 0.2126 * chan(ca[0]) + 0.7152 * chan(ca[1]) + 0.0722 * chan(ca[2])
  const lb = 0.2126 * chan(cb[0]) + 0.7152 * chan(cb[1]) + 0.0722 * chan(cb[2])
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export function deriveSelectionBand(
  accent: string,
  ground: string,
  primaryInk: string,
  mutedInk: string,
): string | null {
  const a = parseColor(accent)
  const g = parseColor(ground)
  if (!a || !g || !parseColor(primaryInk) || !parseColor(mutedInk)) return null
  const mixAt = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(a[0], g[0])}${m(a[1], g[1])}${m(a[2], g[2])}`
  }
  let band = mixAt(0.95)
  for (let t = 0.55; t <= 0.96; t += 0.05) {
    const candidate = mixAt(t)
    const muted = contrastRatio(candidate, mutedInk)
    const primary = contrastRatio(candidate, primaryInk)
    if (muted !== null && primary !== null && muted >= 3.0 && primary >= 6.0) {
      band = candidate
      break
    }
  }
  return band
}

export function deriveTextFloorInk(
  ink: string,
  primaryInk: string,
  ground: string,
  floor: number = 4.5,
): string {
  const a = parseColor(ink)
  const p = parseColor(primaryInk)
  if (!a || !p || !parseColor(ground)) return primaryInk
  const mixAt = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(a[0], p[0])}${m(a[1], p[1])}${m(a[2], p[2])}`
  }
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = mixAt(t)
    const ratio = contrastRatio(candidate, ground)
    if (ratio !== null && ratio >= floor) return candidate
  }
  return primaryInk
}

export const SPECTRAL_STOPS = 5

export const SPECTRAL_STATE_FLOOR = 3.0

export const SPECTRAL_STRUCTURE_FLOOR = 1.5

export type SpectralRamp = readonly string[]

export function spectraMix(from: string, to: string, t: number): string {
  const a = parseColor(from)
  const b = parseColor(to)
  if (!a || !b) return from
  const m = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${m(a[0], b[0])}${m(a[1], b[1])}${m(a[2], b[2])}`
}

export function estateGroundBg(t: MercuryThemeTokens): string | undefined {
  return t.spectraGround !== undefined && truecolorActive() && flagEnv('MERCURY_SPECTRA_GROUND') !== '0'
    ? t.canvas
    : undefined
}

export function spectralRamp(
  role: string,
  ground: string,
  stops: number = SPECTRAL_STOPS,
  floor: number = SPECTRAL_STATE_FLOOR,
): SpectralRamp {
  const r = parseColor(role)
  const g = parseColor(ground)
  if (!r || !g || stops < 2) return [role]
  const at = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(g[0], r[0])}${m(g[1], r[1])}${m(g[2], r[2])}`
  }
  let tMin = 1
  for (let t = 0.2; t <= 1.0001; t += 0.05) {
    const c = contrastRatio(at(t), ground)
    if (c !== null && c >= floor) {
      tMin = t
      break
    }
  }
  if (tMin >= 1) return [role]
  const out: string[] = []
  for (let i = 0; i < stops; i++) {
    out.push(at(tMin + (1 - tMin) * (i / (stops - 1))))
  }
  return out
}

const rampCache = new Map<string, SpectralRamp>()

export function spectralRampFor(
  role: string,
  ground: string,
  floor: number = SPECTRAL_STATE_FLOOR,
): SpectralRamp {
  const key = `${role}|${ground}|${floor}`
  const hit = rampCache.get(key)
  if (hit) return hit
  const ramp = spectralRamp(role, ground, SPECTRAL_STOPS, floor)
  rampCache.set(key, ramp)
  return ramp
}

export type AgentAccent = { name: string; color: string }

export type MercuryThemeTokens = {
  canvas?: string
  surface0: string
  surface1: string
  surface2: string
  borderSubtle: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  textInstruction: string
  textInverse: string
  accent: string
  accentSoft: string
  focalRamp: string[]
  spectraGround?: { top: string; bottom: string }
  focus: string
  selection: string
  selectionBand: string
  info: string
  infoText: string
  success: string
  warning: string
  failure: string
  failureText: string
  diffAddRow: string
  diffAddWord: string
  diffRemoveRow: string
  diffRemoveWord: string
  spectral: {
    oasis: SpectralRamp
    terra: SpectralRamp
    dune: SpectralRamp
    amber: SpectralRamp
    crimson: SpectralRamp
  }
  agentAccents: readonly AgentAccent[]
}

function agentAccentsOf(theme: Theme): AgentAccent[] {
  return [
    { name: 'red', color: theme.red_FOR_SUBAGENTS_ONLY },
    { name: 'blue', color: theme.blue_FOR_SUBAGENTS_ONLY },
    { name: 'green', color: theme.green_FOR_SUBAGENTS_ONLY },
    { name: 'yellow', color: theme.yellow_FOR_SUBAGENTS_ONLY },
    { name: 'purple', color: theme.purple_FOR_SUBAGENTS_ONLY },
    { name: 'orange', color: theme.orange_FOR_SUBAGENTS_ONLY },
    { name: 'pink', color: theme.pink_FOR_SUBAGENTS_ONLY },
    { name: 'cyan', color: theme.cyan_FOR_SUBAGENTS_ONLY },
  ]
}

export function isDarkThemeFamily(name: ThemeName): boolean {
  return (
    name === 'dark' ||
    name === 'true-black' ||
    name === 'dark-daltonized' ||
    name === 'dark-ansi'
  )
}

export function listUnresolvedTokenRoles(tokens: MercuryThemeTokens): string[] {
  const unresolved: string[] = []
  const walk = (path: string, v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length === 0) unresolved.push(path)
      return
    }
    if (Array.isArray(v)) {
      if (v.length === 0) unresolved.push(path)
      else v.forEach((el, i) => walk(`${path}[${i}]`, el))
      return
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v)
      if (entries.length === 0) unresolved.push(path)
      else for (const [k, child] of entries) walk(`${path}.${k}`, child)
      return
    }
    unresolved.push(path)
  }
  for (const [k, v] of Object.entries(tokens)) {
    if (k === 'canvas' && v === undefined) continue
    walk(k, v)
  }
  return unresolved
}

const tokenCache = new Map<string, MercuryThemeTokens>()

export function resolveMercuryTokens(
  themeName: ThemeName,
  accent: string,
): MercuryThemeTokens {
  const key = `${themeName}|${accent}`
  const cached = tokenCache.get(key)
  if (cached) return cached

  const theme = getTheme(themeName)
  let tokens: MercuryThemeTokens
  if (themeName === 'dark' || themeName === 'true-black') {
    const ground = groundFamilyFor(themeName)
    const spectraBottom = spectraMix(ground.NIGHT, OASIS, 0.25)
    tokens = {
      canvas: ground.NIGHT,
      spectraGround: { top: ground.NIGHT, bottom: spectraBottom },
      surface0: ground.NIGHT_SOFT,
      surface1: ground.ASH,
      surface2: ground.ASH_RAISED,
      borderSubtle: DUNE_FAINT,
      borderStrong: DUNE,
      textPrimary: IVORY,
      textSecondary: SECOND,
      textMuted: FAINT,
      textInstruction: deriveTextFloorInk(FAINT, IVORY, spectraBottom),
      textInverse: ground.NIGHT,
      accent,
      accentSoft: accent === TERRA ? BELLY : deriveAccentSoft(accent, IVORY),
      focalRamp: deriveFocalRamp(
        accent,
        accent === TERRA ? BELLY : deriveAccentSoft(accent, IVORY),
        IVORY,
      ),
      focus: accent,
      selection: DUNE,
      selectionBand: deriveSelectionBand(accent, ground.NIGHT, IVORY, FAINT) ?? DUNE,
      info: OASIS,
      infoText: deriveTextFloorInk(OASIS, IVORY, spectraBottom),
      success: TEAL,
      warning: AMBER,
      failure: CRIMSON,
      failureText: deriveTextFloorInk(CRIMSON, IVORY, spectraBottom),
      diffAddRow: DIFF_ADD_BG,
      diffAddWord: DIFF_ADD_WORD,
      diffRemoveRow: DIFF_DEL_BG,
      diffRemoveWord: DIFF_DEL_WORD,
      spectral: {
        oasis: spectralRampFor(OASIS, ground.NIGHT_SOFT),
        terra: spectralRampFor(accent, ground.NIGHT_SOFT),
        dune: spectralRampFor(DUNE, ground.NIGHT_SOFT, SPECTRAL_STRUCTURE_FLOOR),
        amber: spectralRampFor(AMBER, ground.NIGHT_SOFT),
        crimson: spectralRampFor(CRIMSON, ground.NIGHT_SOFT),
      },
      agentAccents: agentAccentsOf(theme),
    }
  } else {
    const dark = isDarkThemeFamily(themeName)
    tokens = {
      ...(dark ? { canvas: NIGHT } : {}),
      surface0: theme.userMessageBackground,
      surface1: theme.userMessageBackground,
      surface2: theme.userMessageBackgroundHover,
      borderSubtle: theme.inactive,
      borderStrong: theme.subtle,
      textPrimary: theme.text,
      textSecondary: theme.subtle,
      textMuted: theme.inactive,
      textInstruction: theme.subtle,
      textInverse: theme.inverseText,
      accent,
      accentSoft: deriveAccentSoft(accent, theme.text),
      focalRamp: [accent],
      focus: accent,
      selection: theme.selectionBg,
      selectionBand:
        deriveSelectionBand(accent, theme.userMessageBackground, theme.text, theme.inactive) ??
        theme.selectionBg,
      info: theme.info,
      infoText: theme.info,
      success: theme.success,
      warning: theme.warning,
      failure: theme.error,
      failureText: theme.error,
      diffAddRow: theme.diffAdded,
      diffAddWord: theme.diffAddedWord,
      diffRemoveRow: theme.diffRemoved,
      diffRemoveWord: theme.diffRemovedWord,
      spectral: {
        oasis: spectralRampFor(theme.info, theme.userMessageBackground),
        terra: spectralRampFor(accent, theme.userMessageBackground),
        dune: spectralRampFor(theme.subtle, theme.userMessageBackground, SPECTRAL_STRUCTURE_FLOOR),
        amber: spectralRampFor(theme.warning, theme.userMessageBackground),
        crimson: spectralRampFor(theme.error, theme.userMessageBackground),
      },
      agentAccents: agentAccentsOf(theme),
    }
  }
  const frozen = Object.freeze(tokens)
  tokenCache.set(key, frozen)
  return frozen
}
