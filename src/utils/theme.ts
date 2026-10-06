
import { colorize } from '../ink/colorize.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getSessionAccent } from '../components/mercury-ui/sessionAccent.js'
import {
  AMBER,
  CRIMSON,
  DIFF_ADD_BG,
  DIFF_ADD_WORD,
  DIFF_DEL_BG,
  DIFF_DEL_WORD,
  DUNE,
  FAINT,
  groundFamilyFor,
  IVORY,
  OASIS,
  SAND,
  TEAL,
} from '../components/mercuryPalette.js'


export type Theme = {
  autoAccept: string
  bashBorder: string
  brand: string
  brandShimmer: string
  systemSpinner: string
  systemSpinnerShimmer: string
  permission: string
  permissionShimmer: string
  info: string
  infoShimmer: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string
  promptBorderResting: string
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string
  subtle: string
  suggestion: string
  remember: string
  background: string
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string
  cardBrown: string
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  diffAddedWord: string
  diffRemovedWord: string
  red_FOR_SUBAGENTS_ONLY: string
  blue_FOR_SUBAGENTS_ONLY: string
  green_FOR_SUBAGENTS_ONLY: string
  yellow_FOR_SUBAGENTS_ONLY: string
  purple_FOR_SUBAGENTS_ONLY: string
  orange_FOR_SUBAGENTS_ONLY: string
  pink_FOR_SUBAGENTS_ONLY: string
  cyan_FOR_SUBAGENTS_ONLY: string
  professionalBlue: string
  chromeYellow: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  messageActionsBackground: string
  selectionBg: string
  bashMessageBackgroundColor: string
  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  briefLabelYou: string
  briefLabelAssistant: string
}

export const THEME_NAMES = ['dark', 'true-black'] as const

export type ThemeName = (typeof THEME_NAMES)[number] | (string & {})

export const THEME_SETTINGS = ['auto', ...THEME_NAMES] as const

export type ThemeSetting = (typeof THEME_SETTINGS)[number] | (string & {})

export const REACHABLE_THEME_SETTINGS = ['dark', 'true-black'] as const


export function lerpHex(from: string, to: string, t: number): string {
  const channel = (offset: number): string => {
    const a = parseInt(from.slice(offset, offset + 2), 16)
    const b = parseInt(to.slice(offset, offset + 2), 16)
    return Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

export function themeColorToAnsi(themeColor: string): string {
  const sentinel = '\x00'
  const painted = colorize(sentinel, themeColor, 'foreground')
  const idx = painted.indexOf(sentinel)
  return idx <= 0 ? '' : painted.slice(0, idx)
}


const CARD_BROWN = 'rgb(200, 168, 130)'

const DARK: Theme = {
  brand: 'rgb(221, 68, 68)',
  brandShimmer: 'rgb(227, 134, 129)',
  suggestion: 'rgb(221, 68, 68)',
  permission: 'rgb(221, 68, 68)',
  permissionShimmer: 'rgb(227, 134, 129)',
  promptBorder: 'rgb(221, 68, 68)',
  promptBorderShimmer: 'rgb(227, 134, 129)',
  promptBorderResting: 'rgb(47, 75, 82)',
  info: 'rgb(63, 126, 150)',
  infoShimmer: 'rgb(133, 168, 178)',
  systemSpinner: 'rgb(63, 126, 150)',
  systemSpinnerShimmer: 'rgb(133, 168, 178)',
  ide: 'rgb(63, 126, 150)',
  merged: 'rgb(63, 126, 150)',
  remember: 'rgb(63, 126, 150)',
  bashBorder: 'rgb(63, 126, 150)',
  background: 'rgb(63, 126, 150)',
  professionalBlue: 'rgb(63, 126, 150)',
  chromeYellow: 'rgb(219, 161, 61)',
  autoAccept: 'rgb(219, 161, 61)',
  success: 'rgb(63, 191, 160)',
  warning: 'rgb(219, 161, 61)',
  warningShimmer: 'rgb(226, 189, 125)',
  cardBrown: CARD_BROWN,
  error: 'rgb(232, 85, 106)',
  text: 'rgb(237, 232, 221)',
  inverseText: 'rgb(13, 24, 27)',
  subtle: 'rgb(169, 180, 172)',
  inactive: 'rgb(113, 128, 123)',
  inactiveShimmer: 'rgb(163, 170, 162)',
  diffAdded: 'rgb(8, 38, 32)',
  diffRemoved: 'rgb(48, 16, 20)',
  diffAddedDimmed: 'rgb(10, 32, 30)',
  diffRemovedDimmed: 'rgb(32, 20, 23)',
  diffAddedWord: 'rgb(14, 64, 54)',
  diffRemovedWord: 'rgb(80, 26, 32)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(231, 111, 111)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(107, 166, 239)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(120, 199, 144)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(229, 199, 107)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(176, 141, 232)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(235, 155, 90)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(233, 133, 183)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(99, 202, 209)',
  userMessageBackground: 'rgb(26, 44, 49)',
  userMessageBackgroundHover: 'rgb(35, 58, 64)',
  messageActionsBackground: 'rgb(47, 75, 82)',
  selectionBg: 'rgb(20, 35, 39)',
  bashMessageBackgroundColor: 'rgb(16, 29, 33)',
  memoryBackgroundColor: 'rgb(20, 35, 39)',
  rate_limit_fill: 'rgb(63, 126, 150)',
  rate_limit_empty: 'rgb(35, 58, 64)',
  briefLabelYou: 'rgb(169, 180, 172)',
  briefLabelAssistant: 'rgb(221, 68, 68)',
}

const TRUE_BLACK: Theme = {
  ...DARK,
  inverseText: 'rgb(0, 0, 0)',
  userMessageBackground: 'rgb(14, 24, 27)',
  userMessageBackgroundHover: 'rgb(19, 32, 35)',
  messageActionsBackground: 'rgb(26, 41, 45)',
  selectionBg: 'rgb(11, 19, 21)',
  bashMessageBackgroundColor: 'rgb(8, 15, 17)',
  memoryBackgroundColor: 'rgb(11, 19, 21)',
  rate_limit_empty: 'rgb(19, 32, 35)',
  diffAddedDimmed: 'rgb(4, 21, 18)',
  diffRemovedDimmed: 'rgb(26, 9, 11)',
}

const BASE_PALETTES: Record<string, Theme> = {
  dark: DARK,
  'true-black': TRUE_BLACK,
}


function mercuryWarmInkOverlay(base: Theme, themeName: string): Theme {
  const accent = getSessionAccent().accent
  const accentShimmer = lerpHex(accent, IVORY, 0.4)
  const companionShimmer = lerpHex(OASIS, IVORY, 0.4)
  const ground = groundFamilyFor(themeName)
  return {
    ...base,
    brand: accent,
    suggestion: accent,
    permission: accent,
    promptBorder: accent,
    briefLabelYou: accent,
    briefLabelAssistant: accent,
    brandShimmer: accentShimmer,
    permissionShimmer: accentShimmer,
    promptBorderShimmer: accentShimmer,
    info: OASIS,
    infoShimmer: companionShimmer,
    systemSpinner: OASIS,
    systemSpinnerShimmer: companionShimmer,
    bashBorder: OASIS,
    remember: OASIS,
    rate_limit_fill: OASIS,
    ide: OASIS,
    merged: OASIS,
    background: OASIS,
    professionalBlue: OASIS,
    chromeYellow: OASIS,
    autoAccept: AMBER,
    success: TEAL,
    error: CRIMSON,
    warning: AMBER,
    warningShimmer: lerpHex(AMBER, IVORY, 0.4),
    text: IVORY,
    subtle: SAND,
    inactive: FAINT,
    inactiveShimmer: lerpHex(FAINT, IVORY, 0.4),
    selectionBg: ground.ASH,
    userMessageBackground: ground.ASH_RAISED,
    userMessageBackgroundHover: ground.DUNE_FAINT,
    messageActionsBackground: ground.DUNE,
    promptBorderResting: DUNE,
    diffAdded: DIFF_ADD_BG,
    diffRemoved: DIFF_DEL_BG,
    diffAddedWord: DIFF_ADD_WORD,
    diffRemovedWord: DIFF_DEL_WORD,
    diffAddedDimmed: lerpHex(DIFF_ADD_BG, ground.NIGHT, 0.45),
    diffRemovedDimmed: lerpHex(DIFF_DEL_BG, ground.NIGHT, 0.45),
  }
}

export function getTheme(themeName: ThemeName): Theme {
  const base = BASE_PALETTES[themeName] ?? DARK
  try {
    if (flagEnv('MERCURY_WARM_INK') === '0') return base
    return mercuryWarmInkOverlay(base, themeName)
  } catch {
    return base
  }
}
