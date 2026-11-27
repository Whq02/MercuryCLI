import chalk from 'chalk'
import { rgbToAnsi16, rgbToAnsi8, rgbToXterm256 } from './cell-grid.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import instances from './instances.js'
import type { Color, TextStyles } from './styles.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { ESC } from './termio/ansi.js'
import { csi } from './termio/csi.js'

export type ColorType = 'foreground' | 'background'

export function shouldHonorNoColor(
  env: Record<string, string | undefined> = hostEnv(),
): boolean {
  const noColor = env.NO_COLOR
  const forceColor = env.FORCE_COLOR
  return Boolean(noColor) && (forceColor === undefined || !['', '1', '2', '3', 'true'].includes(forceColor))
}

export const MERCURY_HONORS_NO_COLOR = shouldHonorNoColor(hostEnv())

function honorNoColor(): boolean {
  if (MERCURY_HONORS_NO_COLOR) {
    chalk.level = 0
    return true
  }
  return false
}
export const CHALK_DISABLED_FOR_NO_COLOR = honorNoColor()
if (hostEnv().FORCE_COLOR !== undefined && !['', '1', '2', '3', 'true'].includes(hostEnv().FORCE_COLOR!)) chalk.level = 0

function unknownTermTakesColor(env: Record<string, string | undefined>): boolean {
  if (shouldHonorNoColor(env) || env.FORCE_COLOR !== undefined || env.CI !== undefined) return false
  return Boolean(env.TERM) && env.TERM !== 'dumb'
}
if (chalk.level === 0 && process.stdout.isTTY && unknownTermTakesColor(hostEnv())) chalk.level = 1

export function truecolorFingerprint(
  env: Record<string, string | undefined> = hostEnv(),
): string | null {
  const colorterm = env.COLORTERM
  if (colorterm === 'truecolor' || colorterm === '24bit') return `COLORTERM=${colorterm}`
  if (env.WT_SESSION) return 'WT_SESSION (Windows Terminal)'
  const program = env.TERM_PROGRAM
  if (program === 'vscode' || program === 'iTerm.app' || program === 'WezTerm' || program === 'ghostty') {
    return `TERM_PROGRAM=${program}`
  }
  const term = env.TERM
  if (term === 'xterm-kitty' || term === 'xterm-ghostty' || term === 'wezterm') return `TERM=${term}`
  if (env.KITTY_WINDOW_ID) return 'KITTY_WINDOW_ID (kitty)'
  return null
}
export const TRUECOLOR_FINGERPRINT = truecolorFingerprint(hostEnv())

function boostChalkLevelForFingerprint(): boolean {
  if (TRUECOLOR_FINGERPRINT !== null && chalk.level === 2) {
    chalk.level = 3
    return true
  }
  return false
}
export const CHALK_BOOSTED_FOR_FINGERPRINT = boostChalkLevelForFingerprint()

function readTruecolorFlag(): string | undefined {
  try {
    return flagEnv('MERCURY_TRUECOLOR')
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function clampChalkLevelForMercury(): boolean {
  if (readTruecolorFlag() !== '0') return false
  if (chalk.level > 2) chalk.level = 2
  return true
}
export const CHALK_CLAMPED_FOR_MERCURY: boolean = clampChalkLevelForMercury()

function boostChalkLevelForMercury(): boolean {
  if (CHALK_CLAMPED_FOR_MERCURY || chalk.level < 1 || chalk.level > 2) return false
  if (!isEnvTruthy(readTruecolorFlag())) return false
  if (chalk.level === 1 && hostEnv().TERM === 'linux') return false
  chalk.level = 3
  return true
}
export const CHALK_BOOSTED_FOR_MERCURY: boolean = boostChalkLevelForMercury()

function clampChalkLevelForTmux(): boolean {
  if (isEnvTruthy(readTruecolorFlag())) return false
  if (!hostEnv().TMUX || chalk.level <= 2) return false
  chalk.level = 2
  return true
}
export const CHALK_CLAMPED_FOR_TMUX: boolean = clampChalkLevelForTmux()

export const DETECTED_CHALK_LEVEL: number = chalk.level

export const TRUECOLOR_QUERY = `${ESC}7${csi('48;2;1;2;3m')}${ESC}P$qm${ESC}\\${csi('0m')}${ESC}8`

export function truecolorEcho(setting: string): boolean {
  return /(?:^|;)48[:;]2[:;](?:\d*[:;])?1[:;]2[:;]3(?:;|m|$)/.test(setting)
}

export function truecolorAskable(env: Record<string, string | undefined> = hostEnv()): boolean {
  if (chalk.level >= 3 || shouldHonorNoColor(env) || env.FORCE_COLOR !== undefined) return false
  if (env.TMUX || env.STY || env.TERM_PROGRAM === 'Apple_Terminal' || readTruecolorFlag() !== undefined) return false
  const term = env.TERM
  return term !== undefined && term !== 'dumb' && term !== 'linux' && !term.startsWith('screen')
}

export function takeTruecolorAnswer(echoed: boolean): boolean {
  if (!echoed || !truecolorAskable()) return false
  chalk.level = 3
  return true
}

export function truecolorAnswered(): boolean {
  return chalk.level > DETECTED_CHALK_LEVEL
}

let monochromeTheme = false

export function monochromeThemeActive(): boolean {
  return monochromeTheme
}

export function setMonochromeTheme(on: boolean): boolean {
  if (on === monochromeTheme) return false
  monochromeTheme = on
  instances.get(process.stdout)?.invalidatePrevFrame()
  return true
}

export function colorStripped(): boolean {
  return monochromeTheme || chalk.level === 0
}

export function paletteCollapsed(): boolean {
  return monochromeTheme || chalk.level <= 1
}

export function truecolorActive(): boolean {
  return !monochromeTheme && chalk.level >= 3
}

export function colorDepthWhy(): string {
  if (monochromeTheme) return 'the Black and white theme paints no colour'
  if (CHALK_DISABLED_FOR_NO_COLOR) return 'NO_COLOR is set'
  if (CHALK_CLAMPED_FOR_TMUX) return 'tmux carries 256 colors unless it is configured for 24-bit'
  if (CHALK_CLAMPED_FOR_MERCURY) return 'MERCURY_TRUECOLOR=0 clamps the depth to 256 colors'
  if (CHALK_BOOSTED_FOR_MERCURY) return 'MERCURY_TRUECOLOR=1 forces the full depth'
  if (truecolorAnswered()) return 'the terminal answered at start that it keeps 24-bit color'
  if (CHALK_BOOSTED_FOR_FINGERPRINT) {
    return `${TRUECOLOR_FINGERPRINT} names a terminal with 24-bit color that does not advertise it`
  }
  if (chalk.level >= 3) {
    return TRUECOLOR_FINGERPRINT === null
      ? 'the terminal advertises 24-bit color'
      : `the terminal advertises 24-bit color (${TRUECOLOR_FINGERPRINT})`
  }
  if (chalk.level === 2) {
    return 'the terminal advertises no 24-bit color (COLORTERM is unset and no known truecolor terminal is named)'
  }
  return 'the terminal advertises fewer than 256 colors'
}

export function colorDepth(): 'truecolor' | '256' | '16' | 'none' {
  if (colorStripped()) return 'none'
  return chalk.level >= 3 ? 'truecolor' : chalk.level === 2 ? '256' : '16'
}

type Painter = { fg: (s: string) => string; bg: (s: string) => string }

const NAMED_PAINTERS: Record<string, Painter> = {
  black: { fg: chalk.black, bg: chalk.bgBlack },
  red: { fg: chalk.red, bg: chalk.bgRed },
  green: { fg: chalk.green, bg: chalk.bgGreen },
  yellow: { fg: chalk.yellow, bg: chalk.bgYellow },
  blue: { fg: chalk.blue, bg: chalk.bgBlue },
  magenta: { fg: chalk.magenta, bg: chalk.bgMagenta },
  cyan: { fg: chalk.cyan, bg: chalk.bgCyan },
  white: { fg: chalk.white, bg: chalk.bgWhite },
  blackBright: { fg: chalk.blackBright, bg: chalk.bgBlackBright },
  redBright: { fg: chalk.redBright, bg: chalk.bgRedBright },
  greenBright: { fg: chalk.greenBright, bg: chalk.bgGreenBright },
  yellowBright: { fg: chalk.yellowBright, bg: chalk.bgYellowBright },
  blueBright: { fg: chalk.blueBright, bg: chalk.bgBlueBright },
  magentaBright: { fg: chalk.magentaBright, bg: chalk.bgMagentaBright },
  cyanBright: { fg: chalk.cyanBright, bg: chalk.bgCyanBright },
  whiteBright: { fg: chalk.whiteBright, bg: chalk.bgWhiteBright },
}

const ANSI256_RE = /^ansi256\((\d+)\)$/
const RGB_RE = /^rgb\( ?(\d+), ?(\d+), ?(\d+) ?\)$/
const HEX_RE = /[a-f\d]{6}|[a-f\d]{3}/i

function hexChannels(color: string): [number, number, number] {
  const digits = HEX_RE.exec(color)?.[0] ?? '000000'
  const value = parseInt(digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function paintNearest(str: string, r: number, g: number, b: number, type: ColorType, depth: '256' | '16'): string {
  if (type === 'foreground') return chalk.ansi256(depth === '256' ? rgbToXterm256(r, g, b) : rgbToAnsi16(r, g, b))(str)
  return chalk.bgAnsi256(depth === '256' ? rgbToXterm256(r, g, b) : rgbToAnsi8(r, g, b))(str)
}

export function ansi16InkCode(r: number, g: number, b: number): number {
  const index = rgbToAnsi16(r, g, b)
  return index < 8 ? 30 + index : 82 + index
}

export function rgbSgr(r: number, g: number, b: number, type: ColorType): string {
  const depth = colorDepth()
  const channel = type === 'foreground' ? 38 : 48
  if (depth === 'truecolor') return `\x1b[${channel};2;${r};${g};${b}m`
  if (depth !== '16') return `\x1b[${channel};5;${rgbToXterm256(r, g, b)}m`
  if (type === 'background') return `\x1b[${40 + rgbToAnsi8(r, g, b)}m`
  return `\x1b[${ansi16InkCode(r, g, b)}m`
}

export function colorize(
  str: string,
  color: Color | string | undefined,
  type: ColorType,
): string {
  if (MERCURY_HONORS_NO_COLOR || monochromeTheme) return str
  if (!color) return str

  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    if (Object.hasOwn(NAMED_PAINTERS, name)) {
      const painter = NAMED_PAINTERS[name]!
      return type === 'foreground' ? painter.fg(str) : painter.bg(str)
    }
    return str
  }

  if (color.startsWith('#')) {
    const depth = colorDepth()
    if (depth === '256' || depth === '16') return paintNearest(str, ...hexChannels(color), type, depth)
    return type === 'foreground' ? chalk.hex(color)(str) : chalk.bgHex(color)(str)
  }

  if (color.startsWith('ansi256(')) {
    const match = ANSI256_RE.exec(color)
    if (!match) return str
    const value = Number(match[1])
    return type === 'foreground' ? chalk.ansi256(value)(str) : chalk.bgAnsi256(value)(str)
  }

  if (color.startsWith('rgb(')) {
    const match = RGB_RE.exec(color)
    if (!match) return str
    const r = Number(match[1])
    const g = Number(match[2])
    const b = Number(match[3])
    const depth = colorDepth()
    if (depth === '256' || depth === '16') return paintNearest(str, r, g, b, type, depth)
    return type === 'foreground' ? chalk.rgb(r, g, b)(str) : chalk.bgRgb(r, g, b)(str)
  }

  return str
}

export function applyTextStyles(text: string, styles: TextStyles): string {
  let result = text
  if (styles.inverse) result = chalk.inverse(result)
  if (styles.strikethrough) result = chalk.strikethrough(result)
  if (styles.underline) result = chalk.underline(result)
  if (styles.italic) result = chalk.italic(result)
  if (styles.bold) result = chalk.bold(result)
  if (styles.dim) result = chalk.dim(result)
  if (styles.color) result = colorize(result, styles.color, 'foreground')
  if (styles.backgroundColor) result = colorize(result, styles.backgroundColor, 'background')
  return result
}
