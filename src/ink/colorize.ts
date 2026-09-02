
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

function boostChalkLevelForXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode' && chalk.level === 2) {
    chalk.level = 3
    return true
  }
  return false
}
export const CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()

function boostChalkLevelForMercury(): boolean {
  try {
    if (flagEnv('MERCURY_TRUECOLOR') === '0') {
      if (chalk.level > 2) chalk.level = 2
      return false
    }
    if (chalk.level === 2) {
      chalk.level = 3
      return true
    }
  } catch {
  }
  return false
}
export const CHALK_BOOSTED_FOR_MERCURY = boostChalkLevelForMercury()

function clampChalkLevelForTmux(): boolean {
  if (isEnvTruthy(flagEnv('MERCURY_TRUECOLOR'))) return false
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
