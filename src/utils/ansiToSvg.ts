/**
 * ANSI escape parsing (colours/bold) and an SVG renderer over the parsed
 * lines. The parser here is the single owner; the PNG renderer consumes it.
 */

import { escapeXml } from './xml.js'

export type AnsiColor = { r: number; g: number; b: number }

export type TextSpan = {
  text: string
  color: AnsiColor
  bold: boolean
}

/** One parsed line is its span list — parseAnsi returns an array of these. */
export type ParsedLine = TextSpan[]

export const DEFAULT_FG: AnsiColor = { r: 229, g: 229, b: 229 }
export const DEFAULT_BG: AnsiColor = { r: 30, g: 30, b: 30 }

// The 16-colour palette (SGR 30–37 bright 90–97).
const PALETTE: Record<number, AnsiColor> = {
  30: { r: 0, g: 0, b: 0 },
  31: { r: 205, g: 49, b: 49 },
  32: { r: 13, g: 188, b: 121 },
  33: { r: 229, g: 229, b: 16 },
  34: { r: 36, g: 114, b: 200 },
  35: { r: 188, g: 63, b: 188 },
  36: { r: 17, g: 168, b: 205 },
  37: { r: 229, g: 229, b: 229 },
  90: { r: 102, g: 102, b: 102 },
  91: { r: 241, g: 76, b: 76 },
  92: { r: 35, g: 209, b: 139 },
  93: { r: 245, g: 245, b: 67 },
  94: { r: 59, g: 142, b: 234 },
  95: { r: 214, g: 112, b: 214 },
  96: { r: 41, g: 184, b: 219 },
  97: { r: 255, g: 255, b: 255 },
}

// The classic VGA table for 256-colour indices 0–15.
const VGA_16: AnsiColor[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
]

/**
 * xterm 256-colour lookup. The out-of-range handling is asymmetric on
 * purpose: a negative index takes the low branch, misses the table and
 * falls back to the default foreground; an index above 255 runs through the
 * grey formula unclamped; a non-numeric index satisfies neither range test
 * and yields not-a-number channels.
 */
function color256(index: number): AnsiColor {
  if (index < 16) {
    return VGA_16[index] ?? DEFAULT_FG
  }
  if (index <= 231) {
    const cubeIndex = index - 16
    const rLevel = Math.floor(cubeIndex / 36)
    const gLevel = Math.floor(cubeIndex / 6) % 6
    const bLevel = cubeIndex % 6
    const channel = (level: number): number => (level === 0 ? 0 : 55 + 40 * level)
    return { r: channel(rLevel), g: channel(gLevel), b: channel(bLevel) }
  }
  const grey = (index - 232) * 10 + 8
  return { r: grey, g: grey, b: grey }
}

const ESC = '\u001b'

/**
 * Parse ANSI-escaped text into per-line spans.
 *
 * Recognised SGR codes: 0 (reset colour and bold), 1 (bold on), 30–37 and
 * 90–97, 39 (default foreground), 38;5;n, 38;2;r;g;b. Any other code is
 * ignored but consumed one parameter at a time — the parser knows the arity
 * of only the two extended-foreground forms, so the parameters of an
 * unrecognised multi-parameter code (48;5;31, say) are re-interpreted as
 * codes in their own right. That is the shipped behaviour; do not add
 * background-code arity from SGR knowledge. Bold is only ever turned on —
 * there is no 22 handling, only a 0 reset clears it.
 *
 * An escape sequence is ESC `[` … first ASCII letter; only an `m`
 * terminator is interpreted, others are skipped whole. An escape with no
 * letter before end-of-line consumes the rest of that line. A lone ESC not
 * followed by `[` is consumed so the scan always makes forward progress
 * (guarding the stray-ESC hang; the deviation is recorded in the rewrite
 * receipt).
 */
export function parseAnsi(text: string): ParsedLine[] {
  const lines = text.split('\n')
  return lines.map(line => {
    const spans: TextSpan[] = []
    let color = DEFAULT_FG
    let bold = false
    let i = 0
    while (i < line.length) {
      if (line[i] === ESC) {
        if (line[i + 1] === '[') {
          let j = i + 2
          while (j < line.length && !/[A-Za-z]/.test(line[j] as string)) {
            j++
          }
          if (j >= line.length) {
            // No terminator before end of line: consume the rest.
            i = line.length
            break
          }
          if (line[j] === 'm') {
            // Empty parameters convert to 0 and act as resets: ESC[m resets,
            // ESC[;1m resets then sets bold.
            const params = line
              .slice(i + 2, j)
              .split(';')
              .map(p => Number(p))
            let k = 0
            while (k < params.length) {
              const code = params[k] as number
              if (code === 0) {
                color = DEFAULT_FG
                bold = false
                k++
              } else if (code === 1) {
                bold = true
                k++
              } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
                color = PALETTE[code] as AnsiColor
                k++
              } else if (code === 39) {
                color = DEFAULT_FG
                k++
              } else if (code === 38 && params[k + 1] === 5 && k + 2 < params.length) {
                color = color256(params[k + 2] as number)
                k += 3
              } else if (code === 38 && params[k + 1] === 2 && k + 4 < params.length) {
                color = {
                  r: params[k + 2] as number,
                  g: params[k + 3] as number,
                  b: params[k + 4] as number,
                }
                k += 5
              } else {
                // Unrecognised (or truncated extended) code: consume one
                // parameter; any leftovers are read as codes themselves.
                k++
              }
            }
          }
          i = j + 1
        } else {
          // Stray ESC without `[` — consume it (forward-progress guard).
          i++
        }
      } else {
        let next = line.indexOf(ESC, i)
        if (next === -1) next = line.length
        const runText = line.slice(i, next)
        if (runText.length > 0) {
          spans.push({ text: runText, color, bold })
        }
        i = next
      }
    }
    if (spans.length === 0) {
      spans.push({ text: '', color: DEFAULT_FG, bold: false })
    }
    return spans
  })
}

export type AnsiToSvgOptions = {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  paddingX?: number
  paddingY?: number
  backgroundColor?: string
  borderRadius?: number
}

function rgb(color: AnsiColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

function isBlankLine(line: ParsedLine): boolean {
  return line.every(span => /^\s*$/.test(span.text))
}

/**
 * Render ANSI text to an SVG document: one background rounded rectangle, a
 * style block (establishing the monospace font and the `b` bold class —
 * external consumers may restyle that class), and one text element per line
 * with one tspan per non-empty span. Whitespace is preserved by both the
 * CSS rule and the per-text space-preserve attribute.
 */
export function ansiToSvg(ansiText: string, options: AnsiToSvgOptions = {}): string {
  const {
    fontFamily = 'Menlo, Monaco, monospace',
    fontSize = 14,
    lineHeight = 22,
    paddingX = 24,
    paddingY = 24,
    backgroundColor = rgb(DEFAULT_BG),
    borderRadius = 8,
  } = options

  const lines = parseAnsi(ansiText)
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1] as ParsedLine)) {
    lines.pop()
  }

  // Width estimate over the RAW character count of the spans' text — not
  // terminal cell width; that difference from the PNG path is deliberate.
  // An all-blank input leaves no lines at all; guard the empty maximum so
  // the width is a real number (deviation recorded in the rewrite receipt).
  let maxLineChars = 0
  for (const line of lines) {
    const chars = line.reduce((total, span) => total + span.text.length, 0)
    if (chars > maxLineChars) maxLineChars = chars
  }

  const width = Math.ceil(maxLineChars * fontSize * 0.6 + 2 * paddingX)
  const height = lines.length * lineHeight + 2 * paddingY

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  )
  parts.push(
    `<rect width="${width}" height="${height}" fill="${backgroundColor}" rx="${borderRadius}"/>`,
  )
  parts.push(
    `<style>text { font-family: ${fontFamily}; font-size: ${fontSize}px; white-space: pre; } .b { font-weight: bold; }</style>`,
  )
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as ParsedLine
    const baselineY = paddingY + (i + 1) * lineHeight - (lineHeight - fontSize) / 2
    const tspans = line
      .filter(span => span.text.length > 0)
      .map(span => {
        const classAttr = span.bold ? ' class="b"' : ''
        return `<tspan fill="${rgb(span.color)}"${classAttr}>${escapeXml(span.text)}</tspan>`
      })
      .join('')
    parts.push(`<text x="${paddingX}" y="${baselineY}" xml:space="preserve">${tspans}</text>`)
  }
  parts.push('</svg>')
  return parts.join('\n')
}
