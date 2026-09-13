
import chalk from 'chalk'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import type { Color, TextStyles } from './styles.js'

export type ColorType = 'foreground' | 'background'

export function shouldHonorNoColor(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const noColor = env.NO_COLOR
  const forceColor = env.FORCE_COLOR
  return Boolean(noColor) && !forceColor
}

export const MERCURY_HONORS_NO_COLOR = shouldHonorNoColor(process.env)

function honorNoColor(): boolean {
  if (MERCURY_HONORS_NO_COLOR) {
    chalk.level = 0
    return true
  }
  return false
}
export const CHALK_DISABLED_FOR_NO_COLOR = honorNoColor()

export function truecolorFingerprint(
  env: Record<string, string | undefined> = process.env,
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
export const TRUECOLOR_FINGERPRINT = truecolorFingerprint(process.env)

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
  } catch {
    return undefined
  }
}

function clampChalkLevelForMercury(): boolean {
  if (readTruecolorFlag() !== '0') return false
  if (chalk.level > 2) chalk.level = 2
  return true
}
export const CHALK_CLAMPED_FOR_MERCURY = clampChalkLevelForMercury()

function boostChalkLevelForMercury(): boolean {
  if (CHALK_CLAMPED_FOR_MERCURY || chalk.level !== 2 || !isEnvTruthy(readTruecolorFlag())) return false
  chalk.level = 3
  return true
}
export const CHALK_BOOSTED_FOR_MERCURY = boostChalkLevelForMercury()

function clampChalkLevelForTmux(): boolean {
  if (isEnvTruthy(readTruecolorFlag())) return false
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2
    return true
  }
  return false
}
export const CHALK_CLAMPED_FOR_TMUX = clampChalkLevelForTmux()

export function paletteCollapsed(): boolean {
  return chalk.level <= 1
}

export function truecolorActive(): boolean {
  return chalk.level >= 3
}

export function colorDepthWhy(): string {
  if (CHALK_DISABLED_FOR_NO_COLOR) return 'NO_COLOR is set'
  if (CHALK_CLAMPED_FOR_TMUX) return 'tmux carries 256 colors unless it is configured for 24-bit'
  if (CHALK_CLAMPED_FOR_MERCURY) return 'MERCURY_TRUECOLOR=0 clamps the depth to 256 colors'
  if (CHALK_BOOSTED_FOR_MERCURY) return 'MERCURY_TRUECOLOR=1 forces the full depth'
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

export function colorize(
  str: string,
  color: Color | string | undefined,
  type: ColorType,
): string {
  if (MERCURY_HONORS_NO_COLOR) return str
  if (!color) return str
  if (color.startsWith('ansi:')) {
    const painter = NAMED_PAINTERS[color.slice('ansi:'.length)]
    if (!painter) return str
    return type === 'foreground' ? painter.fg(str) : painter.bg(str)
  }
  if (color.startsWith('#')) {
    return type === 'foreground' ? chalk.hex(color)(str) : chalk.bgHex(color)(str)
  }
  if (color.startsWith('ansi256(')) {
    const match = ANSI256_RE.exec(color)
    if (!match) return str
    const index = Number(match[1])
    return type === 'foreground'
      ? chalk.ansi256(index)(str)
      : chalk.bgAnsi256(index)(str)
  }
  if (color.startsWith('rgb(')) {
    const match = RGB_RE.exec(color)
    if (!match) return str
    const r = Number(match[1])
    const g = Number(match[2])
    const b = Number(match[3])
    return type === 'foreground'
      ? chalk.rgb(r, g, b)(str)
      : chalk.bgRgb(r, g, b)(str)
  }
  return str
}

export function applyTextStyles(text: string, styles: TextStyles): string {
  let out = text
  if (styles.inverse) out = chalk.inverse(out)
  if (styles.strikethrough) out = chalk.strikethrough(out)
  if (styles.underline) out = chalk.underline(out)
  if (styles.italic) out = chalk.italic(out)
  if (styles.bold) out = chalk.bold(out)
  if (styles.dim) out = chalk.dim(out)
  if (styles.color) out = colorize(out, styles.color, 'foreground')
  if (styles.backgroundColor) {
    out = colorize(out, styles.backgroundColor, 'background')
  }
  return out
}

export function applyColor(text: string, color?: Color | string): string {
  if (!color) return text
  return colorize(text, color, 'foreground')
}
