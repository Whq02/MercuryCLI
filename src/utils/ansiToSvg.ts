
import { escapeXml } from './xml.js'

export type AnsiColor = { r: number; g: number; b: number }

export type TextSpan = {
  text: string
  color: AnsiColor
  bold: boolean
}

export type ParsedLine = TextSpan[]

export const DEFAULT_FG: AnsiColor = { r: 229, g: 229, b: 229 }
export const DEFAULT_BG: AnsiColor = { r: 30, g: 30, b: 30 }

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
            i = line.length
            break
          }
          if (line[j] === 'm') {
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
                k++
              }
            }
          }
          i = j + 1
        } else {
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
