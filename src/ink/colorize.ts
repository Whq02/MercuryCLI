// Colour-depth policy + colour-string → styled-string dispatch. The emitted
// depth is decided ONCE at module load, in a fixed order, and each decision
// is exposed as a constant so diagnostics can report what happened.

import chalk from 'chalk'
import { flagEnv } from '../substrate/flagRegistry.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import type { Color, TextStyles } from './styles.js'

export type ColorType = 'foreground' | 'background'

/**
 * The published NO_COLOR precedence rule, pure and testable: honour
 * `NO_COLOR` when set non-empty AND `FORCE_COLOR` is NOT set non-empty
 * (the specification gives FORCE_COLOR precedence). The bundled capability
 * detector honours FORCE_COLOR=0 but not NO_COLOR on a truecolor terminal —
 * exactly the gap this closes.
 */
export function shouldHonorNoColor(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const noColor = env.NO_COLOR
  const forceColor = env.FORCE_COLOR
  return Boolean(noColor) && !forceColor
}

// 1. Honour NO_COLOR: level 0 strips every escape process-wide (the colour
//    engine is a singleton); the colouring function also short-circuits at
//    call time as a second line of defence.
export const MERCURY_HONORS_NO_COLOR = shouldHonorNoColor(process.env)

function honorNoColor(): boolean {
  if (MERCURY_HONORS_NO_COLOR) {
    chalk.level = 0
    return true
  }
  return false
}
export const CHALK_DISABLED_FOR_NO_COLOR = honorNoColor()

// 2. Boost xterm.js-family terminals: they have supported truecolor for
//    years without advertising it, and at level 2 the brand accent snaps to
//    the nearest 6×6×6 cube entry. Gated on level EXACTLY 2 so a NO_COLOR
//    session (level 0) is never re-coloured; runs BEFORE the multiplexer
//    clamp so a multiplexer inside such a terminal still wins.
function boostChalkLevelForXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode' && chalk.level === 2) {
    chalk.level = 3
    return true
  }
  return false
}
export const CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()

// 3. The registered truecolor flag: `=0` is an honest DEPTH CLAMP (any level
//    above 2 comes DOWN to 2), otherwise level 2 is raised to 3 so hex
//    colours emit as 24-bit and the brand accent lands exactly. A
//    configuration read failure leaves the level untouched.
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
    // Leave the level untouched.
  }
  return false
}
export const CHALK_BOOSTED_FOR_MERCURY = boostChalkLevelForMercury()

// 4. Clamp for terminal multiplexers: a stock multiplexer stores 24-bit
//    faithfully but drops the sequence on the way out unless a capability
//    override is configured, so the cell renders on the outer terminal's
//    default ground. The 256-colour form survives the hop. TMUX is set by
//    the multiplexer itself on the pty, so reading it directly is correct;
//    an explicitly truthy MERCURY_TRUECOLOR is the cheap opt-out for a
//    configured setup (the one spelling — no compat alias).
function clampChalkLevelForTmux(): boolean {
  if (isEnvTruthy(flagEnv('MERCURY_TRUECOLOR'))) return false
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2
    return true
  }
  return false
}
export const CHALK_CLAMPED_FOR_TMUX = clampChalkLevelForTmux()

/** ≤ 1: colour cannot carry focus or hierarchy — callers fork onto
 *  glyph/border-shape affordances. */
export function paletteCollapsed(): boolean {
  return chalk.level <= 1
}

/** ≥ 3: graded background fields are honest; below this consumers fall back
 *  to their flat off-state (a 256-cube gradient bands visibly). */
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
// Optional single leading space after each comma and inside the parentheses.
const RGB_RE = /^rgb\( ?(\d+), ?(\d+), ?(\d+) ?\)$/

/**
 * Colour a string for one channel. Malformed-input tolerance is
 * load-bearing: a caller elsewhere detects a bad colour by observing the
 * input returned untouched.
 */
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

/**
 * Apply structured text styles. The apply ORDER is part of the pinned
 * output, because the styling engine wraps outward: modifiers first, then
 * foreground, then background outermost.
 */
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

/** Apply a raw colour value as a foreground; no colour returns the text
 *  unchanged. */
export function applyColor(text: string, color?: Color | string): string {
  if (!color) return text
  return colorize(text, color, 'foreground')
}
