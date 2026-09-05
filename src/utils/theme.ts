
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
  TERRA,
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
  planMode: string
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

export const THEME_NAMES = [
  'dark',
  'true-black',
  'light',
  'light-daltonized',
  'dark-daltonized',
  'light-ansi',
  'dark-ansi',
] as const

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
  planMode: 'rgb(63, 126, 150)',
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

const LIGHT: Theme = {
  brand: 'rgb(196, 54, 54)',
  brandShimmer: 'rgb(216, 108, 98)',
  suggestion: 'rgb(196, 54, 54)',
  permission: 'rgb(196, 54, 54)',
  permissionShimmer: 'rgb(216, 108, 98)',
  promptBorder: 'rgb(196, 54, 54)',
  promptBorderShimmer: 'rgb(216, 108, 98)',
  promptBorderResting: 'rgb(178, 190, 186)',
  info: 'rgb(43, 94, 115)',
  infoShimmer: 'rgb(94, 138, 155)',
  systemSpinner: 'rgb(43, 94, 115)',
  systemSpinnerShimmer: 'rgb(94, 138, 155)',
  planMode: 'rgb(43, 94, 115)',
  ide: 'rgb(43, 94, 115)',
  merged: 'rgb(43, 94, 115)',
  remember: 'rgb(43, 94, 115)',
  bashBorder: 'rgb(43, 94, 115)',
  background: 'rgb(43, 94, 115)',
  professionalBlue: 'rgb(38, 90, 140)',
  chromeYellow: 'rgb(158, 112, 24)',
  autoAccept: 'rgb(158, 112, 24)',
  success: 'rgb(23, 128, 104)',
  warning: 'rgb(158, 112, 24)',
  warningShimmer: 'rgb(191, 152, 72)',
  error: 'rgb(191, 42, 66)',
  text: 'rgb(23, 42, 48)',
  inverseText: 'rgb(250, 248, 243)',
  subtle: 'rgb(94, 110, 104)',
  inactive: 'rgb(112, 124, 120)',
  inactiveShimmer: 'rgb(150, 160, 156)',
  diffAdded: 'rgb(214, 238, 230)',
  diffRemoved: 'rgb(248, 220, 224)',
  diffAddedDimmed: 'rgb(233, 245, 240)',
  diffRemovedDimmed: 'rgb(250, 235, 238)',
  diffAddedWord: 'rgb(168, 221, 205)',
  diffRemovedWord: 'rgb(240, 183, 192)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(178, 45, 45)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(31, 102, 189)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(34, 128, 62)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(158, 112, 24)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(123, 76, 181)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(184, 95, 22)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(180, 54, 126)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(18, 127, 138)',
  userMessageBackground: 'rgb(238, 241, 239)',
  userMessageBackgroundHover: 'rgb(226, 232, 229)',
  messageActionsBackground: 'rgb(213, 222, 218)',
  selectionBg: 'rgb(204, 224, 233)',
  bashMessageBackgroundColor: 'rgb(240, 243, 241)',
  memoryBackgroundColor: 'rgb(238, 241, 239)',
  rate_limit_fill: 'rgb(43, 94, 115)',
  rate_limit_empty: 'rgb(213, 222, 218)',
  briefLabelYou: 'rgb(94, 110, 104)',
  briefLabelAssistant: 'rgb(196, 54, 54)',
}

const DARK_DALTONIZED: Theme = {
  brand: 'rgb(170, 111, 214)',
  brandShimmer: 'rgb(197, 159, 226)',
  suggestion: 'rgb(170, 111, 214)',
  permission: 'rgb(170, 111, 214)',
  permissionShimmer: 'rgb(197, 159, 226)',
  promptBorder: 'rgb(170, 111, 214)',
  promptBorderShimmer: 'rgb(197, 159, 226)',
  promptBorderResting: 'rgb(47, 75, 82)',
  info: 'rgb(85, 178, 192)',
  infoShimmer: 'rgb(146, 200, 204)',
  systemSpinner: 'rgb(85, 178, 192)',
  systemSpinnerShimmer: 'rgb(146, 200, 204)',
  planMode: 'rgb(85, 178, 192)',
  ide: 'rgb(85, 178, 192)',
  merged: 'rgb(85, 178, 192)',
  remember: 'rgb(85, 178, 192)',
  bashBorder: 'rgb(85, 178, 192)',
  background: 'rgb(85, 178, 192)',
  professionalBlue: 'rgb(85, 178, 192)',
  chromeYellow: 'rgb(219, 161, 61)',
  autoAccept: 'rgb(219, 161, 61)',
  success: 'rgb(77, 141, 244)',
  warning: 'rgb(219, 161, 61)',
  warningShimmer: 'rgb(226, 189, 125)',
  error: 'rgb(232, 85, 106)',
  text: 'rgb(237, 232, 221)',
  inverseText: 'rgb(13, 24, 27)',
  subtle: 'rgb(169, 180, 172)',
  inactive: 'rgb(113, 128, 123)',
  inactiveShimmer: 'rgb(163, 170, 162)',
  diffAdded: 'rgb(13, 34, 66)',
  diffRemoved: 'rgb(48, 16, 20)',
  diffAddedDimmed: 'rgb(13, 30, 48)',
  diffRemovedDimmed: 'rgb(32, 20, 23)',
  diffAddedWord: 'rgb(21, 54, 101)',
  diffRemovedWord: 'rgb(80, 26, 32)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(196, 120, 84)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(96, 148, 244)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(148, 208, 220)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(229, 199, 107)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(160, 140, 230)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(226, 168, 92)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(232, 170, 190)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(64, 180, 170)',
  userMessageBackground: 'rgb(26, 44, 49)',
  userMessageBackgroundHover: 'rgb(35, 58, 64)',
  messageActionsBackground: 'rgb(47, 75, 82)',
  selectionBg: 'rgb(20, 35, 39)',
  bashMessageBackgroundColor: 'rgb(16, 29, 33)',
  memoryBackgroundColor: 'rgb(20, 35, 39)',
  rate_limit_fill: 'rgb(85, 178, 192)',
  rate_limit_empty: 'rgb(35, 58, 64)',
  briefLabelYou: 'rgb(169, 180, 172)',
  briefLabelAssistant: 'rgb(170, 111, 214)',
}

const LIGHT_DALTONIZED: Theme = {
  brand: 'rgb(123, 76, 181)',
  brandShimmer: 'rgb(163, 126, 209)',
  suggestion: 'rgb(123, 76, 181)',
  permission: 'rgb(123, 76, 181)',
  permissionShimmer: 'rgb(163, 126, 209)',
  promptBorder: 'rgb(123, 76, 181)',
  promptBorderShimmer: 'rgb(163, 126, 209)',
  promptBorderResting: 'rgb(178, 190, 186)',
  info: 'rgb(18, 127, 138)',
  infoShimmer: 'rgb(94, 168, 176)',
  systemSpinner: 'rgb(18, 127, 138)',
  systemSpinnerShimmer: 'rgb(94, 168, 176)',
  planMode: 'rgb(18, 127, 138)',
  ide: 'rgb(18, 127, 138)',
  merged: 'rgb(18, 127, 138)',
  remember: 'rgb(18, 127, 138)',
  bashBorder: 'rgb(18, 127, 138)',
  background: 'rgb(18, 127, 138)',
  professionalBlue: 'rgb(18, 127, 138)',
  chromeYellow: 'rgb(158, 112, 24)',
  autoAccept: 'rgb(158, 112, 24)',
  success: 'rgb(31, 102, 189)',
  warning: 'rgb(158, 112, 24)',
  warningShimmer: 'rgb(191, 152, 72)',
  error: 'rgb(191, 42, 66)',
  text: 'rgb(23, 42, 48)',
  inverseText: 'rgb(250, 248, 243)',
  subtle: 'rgb(94, 110, 104)',
  inactive: 'rgb(112, 124, 120)',
  inactiveShimmer: 'rgb(150, 160, 156)',
  diffAdded: 'rgb(213, 228, 248)',
  diffRemoved: 'rgb(248, 220, 224)',
  diffAddedDimmed: 'rgb(232, 240, 250)',
  diffRemovedDimmed: 'rgb(250, 235, 238)',
  diffAddedWord: 'rgb(168, 199, 240)',
  diffRemovedWord: 'rgb(240, 183, 192)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(152, 86, 54)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(31, 102, 189)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(18, 127, 138)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(158, 112, 24)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(123, 76, 181)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(178, 124, 32)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(170, 96, 140)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(16, 150, 160)',
  userMessageBackground: 'rgb(238, 241, 239)',
  userMessageBackgroundHover: 'rgb(226, 232, 229)',
  messageActionsBackground: 'rgb(213, 222, 218)',
  selectionBg: 'rgb(208, 222, 240)',
  bashMessageBackgroundColor: 'rgb(240, 243, 241)',
  memoryBackgroundColor: 'rgb(238, 241, 239)',
  rate_limit_fill: 'rgb(18, 127, 138)',
  rate_limit_empty: 'rgb(213, 222, 218)',
  briefLabelYou: 'rgb(94, 110, 104)',
  briefLabelAssistant: 'rgb(123, 76, 181)',
}

const DARK_ANSI: Theme = {
  brand: 'ansi:red',
  brandShimmer: 'ansi:redBright',
  suggestion: 'ansi:red',
  permission: 'ansi:red',
  permissionShimmer: 'ansi:red',
  promptBorder: 'ansi:red',
  promptBorderShimmer: 'ansi:redBright',
  promptBorderResting: 'ansi:blackBright',
  info: 'ansi:cyan',
  infoShimmer: 'ansi:cyanBright',
  systemSpinner: 'ansi:cyan',
  systemSpinnerShimmer: 'ansi:cyan',
  planMode: 'ansi:cyan',
  ide: 'ansi:cyan',
  merged: 'ansi:cyan',
  remember: 'ansi:cyan',
  bashBorder: 'ansi:cyan',
  background: 'ansi:cyan',
  professionalBlue: 'ansi:blue',
  chromeYellow: 'ansi:yellow',
  autoAccept: 'ansi:yellow',
  success: 'ansi:green',
  warning: 'ansi:yellow',
  warningShimmer: 'ansi:yellow',
  error: 'ansi:red',
  text: 'ansi:whiteBright',
  inverseText: 'ansi:black',
  subtle: 'ansi:white',
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:white',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  userMessageBackground: 'ansi:black',
  userMessageBackgroundHover: 'ansi:blackBright',
  messageActionsBackground: 'ansi:blue',
  selectionBg: 'ansi:blue',
  bashMessageBackgroundColor: 'ansi:black',
  memoryBackgroundColor: 'ansi:black',
  rate_limit_fill: 'ansi:cyan',
  rate_limit_empty: 'ansi:blackBright',
  briefLabelYou: 'ansi:white',
  briefLabelAssistant: 'ansi:red',
}

const LIGHT_ANSI: Theme = {
  brand: 'ansi:red',
  brandShimmer: 'ansi:redBright',
  suggestion: 'ansi:red',
  permission: 'ansi:red',
  permissionShimmer: 'ansi:redBright',
  promptBorder: 'ansi:red',
  promptBorderShimmer: 'ansi:redBright',
  promptBorderResting: 'ansi:blackBright',
  info: 'ansi:blue',
  infoShimmer: 'ansi:cyan',
  systemSpinner: 'ansi:blue',
  systemSpinnerShimmer: 'ansi:cyan',
  planMode: 'ansi:blue',
  ide: 'ansi:blue',
  merged: 'ansi:blue',
  remember: 'ansi:blue',
  bashBorder: 'ansi:blue',
  background: 'ansi:blue',
  professionalBlue: 'ansi:blue',
  chromeYellow: 'ansi:yellow',
  autoAccept: 'ansi:yellow',
  success: 'ansi:green',
  warning: 'ansi:yellow',
  warningShimmer: 'ansi:yellowBright',
  error: 'ansi:red',
  text: 'ansi:black',
  inverseText: 'ansi:whiteBright',
  subtle: 'ansi:blackBright',
  inactive: 'ansi:blackBright',
  inactiveShimmer: 'ansi:blackBright',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedDimmed: 'ansi:green',
  diffRemovedDimmed: 'ansi:red',
  diffAddedWord: 'ansi:greenBright',
  diffRemovedWord: 'ansi:redBright',
  red_FOR_SUBAGENTS_ONLY: 'ansi:red',
  blue_FOR_SUBAGENTS_ONLY: 'ansi:blue',
  green_FOR_SUBAGENTS_ONLY: 'ansi:green',
  yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellow',
  purple_FOR_SUBAGENTS_ONLY: 'ansi:magenta',
  orange_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
  pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
  cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyan',
  userMessageBackground: 'ansi:white',
  userMessageBackgroundHover: 'ansi:whiteBright',
  messageActionsBackground: 'ansi:cyan',
  selectionBg: 'ansi:cyan',
  bashMessageBackgroundColor: 'ansi:white',
  memoryBackgroundColor: 'ansi:white',
  rate_limit_fill: 'ansi:blue',
  rate_limit_empty: 'ansi:white',
  briefLabelYou: 'ansi:blackBright',
  briefLabelAssistant: 'ansi:red',
}

const BASE_PALETTES: Record<string, Theme> = {
  dark: DARK,
  'true-black': TRUE_BLACK,
  light: LIGHT,
  'light-daltonized': LIGHT_DALTONIZED,
  'dark-daltonized': DARK_DALTONIZED,
  'light-ansi': LIGHT_ANSI,
  'dark-ansi': DARK_ANSI,
}


function isWarmInkFamily(themeName: string): boolean {
  return (
    !themeName.startsWith('light') &&
    !themeName.includes('daltonized') &&
    !themeName.includes('ansi')
  )
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
    planMode: OASIS,
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

function roleStructureOverlay(themeName: string, base: Theme): Theme {
  let identity: string
  let identityShimmer: string
  let companion: string
  let companionShimmer: string
  if (themeName.includes('daltonized')) {
    identity = base.brand
    identityShimmer = base.brandShimmer
    companion = base.info
    companionShimmer = base.infoShimmer
  } else if (themeName.includes('ansi')) {
    identity = 'ansi:redBright'
    identityShimmer = 'ansi:yellowBright'
    companion = 'ansi:cyan'
    companionShimmer = 'ansi:cyanBright'
  } else if (themeName.startsWith('light')) {
    identity = TERRA
    identityShimmer = lerpHex(TERRA, IVORY, 0.35)
    companion = OASIS
    companionShimmer = lerpHex(OASIS, IVORY, 0.35)
  } else {
    return base
  }
  return {
    ...base,
    brand: identity,
    brandShimmer: identityShimmer,
    suggestion: identity,
    permission: identity,
    permissionShimmer: identityShimmer,
    promptBorder: identity,
    promptBorderShimmer: identityShimmer,
    briefLabelYou: identity,
    briefLabelAssistant: identity,
    info: companion,
    infoShimmer: companionShimmer,
    systemSpinner: companion,
    systemSpinnerShimmer: companionShimmer,
    bashBorder: companion,
    remember: companion,
    rate_limit_fill: companion,
    ide: companion,
    merged: companion,
    planMode: companion,
    background: companion,
    professionalBlue: companion,
    chromeYellow: companion,
    autoAccept: base.warning,
  }
}

export function getTheme(themeName: ThemeName): Theme {
  const base = BASE_PALETTES[themeName] ?? DARK
  try {
    if (flagEnv('MERCURY_WARM_INK') === '0') return base
    if (isWarmInkFamily(themeName)) return mercuryWarmInkOverlay(base, themeName)
    return roleStructureOverlay(themeName, base)
  } catch {
    return base
  }
}
