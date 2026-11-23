export type AnsiColor = { r: number; g: number; b: number }

type TextSpan = {
  text: string
  color: AnsiColor
  bold: boolean
}

export type ParsedLine = TextSpan[]

const rgb = (r: number, g: number, b: number): AnsiColor => ({ r, g, b })

const DEFAULT_FG: AnsiColor = rgb(229, 229, 229)
export const DEFAULT_BG: AnsiColor = rgb(30, 30, 30)

const PALETTE: Record<number, AnsiColor> = {
  30: rgb(0, 0, 0),
  31: rgb(205, 49, 49),
  32: rgb(13, 188, 121),
  33: rgb(229, 229, 16),
  34: rgb(36, 114, 200),
  35: rgb(188, 63, 188),
  36: rgb(17, 168, 205),
  37: rgb(229, 229, 229),
  90: rgb(102, 102, 102),
  91: rgb(241, 76, 76),
  92: rgb(35, 209, 139),
  93: rgb(245, 245, 67),
  94: rgb(59, 142, 234),
  95: rgb(214, 112, 214),
  96: rgb(41, 184, 219),
  97: rgb(255, 255, 255),
}

const VGA_16: AnsiColor[] = [
  rgb(0, 0, 0),
  rgb(128, 0, 0),
  rgb(0, 128, 0),
  rgb(128, 128, 0),
  rgb(0, 0, 128),
  rgb(128, 0, 128),
  rgb(0, 128, 128),
  rgb(192, 192, 192),
  rgb(128, 128, 128),
  rgb(255, 0, 0),
  rgb(0, 255, 0),
  rgb(255, 255, 0),
  rgb(0, 0, 255),
  rgb(255, 0, 255),
  rgb(0, 255, 255),
  rgb(255, 255, 255),
]

const cubeChannel = (level: number): number => (level === 0 ? 0 : 55 + 40 * level)

function xterm256(index: number): AnsiColor {
  if (index < 16) return VGA_16[index] ?? DEFAULT_FG
  if (index <= 231) {
    const cube = index - 16
    return rgb(cubeChannel(Math.floor(cube / 36)), cubeChannel(Math.floor(cube / 6) % 6), cubeChannel(cube % 6))
  }
  const grey = (index - 232) * 10 + 8
  return rgb(grey, grey, grey)
}

type Pen = { color: AnsiColor; bold: boolean }

const freshPen = (): Pen => ({ color: DEFAULT_FG, bold: false })

const isPaletteCode = (code: number): boolean => (code >= 30 && code <= 37) || (code >= 90 && code <= 97)

function applySgr(pen: Pen, params: number[]): void {
  for (let at = 0; at < params.length; ) {
    const code = params[at]!
    const extended = code === 38 ? params[at + 1] : undefined
    if (code === 0) Object.assign(pen, freshPen())
    else if (code === 1) pen.bold = true
    else if (code === 39) pen.color = DEFAULT_FG
    else if (isPaletteCode(code)) pen.color = PALETTE[code]!
    if (extended === 5 && at + 2 < params.length) {
      pen.color = xterm256(params[at + 2]!)
      at += 3
    } else if (extended === 2 && at + 4 < params.length) {
      pen.color = rgb(params[at + 2]!, params[at + 3]!, params[at + 4]!)
      at += 5
    } else {
      at += 1
    }
  }
}

const ESC = '\u001b'
const LETTER = /[A-Za-z]/

function parseLine(line: string): ParsedLine {
  const spans: TextSpan[] = []
  const pen = freshPen()
  let at = 0
  while (at < line.length) {
    if (line[at] !== ESC) {
      const end = line.indexOf(ESC, at)
      const text = line.slice(at, end === -1 ? line.length : end)
      spans.push({ text, color: pen.color, bold: pen.bold })
      at += text.length
      continue
    }
    if (line[at + 1] !== '[') {
      at += 1
      continue
    }
    let final = at + 2
    while (final < line.length && !LETTER.test(line[final]!)) final++
    if (final >= line.length) break
    if (line[final] === 'm') applySgr(pen, line.slice(at + 2, final).split(';').map(Number))
    at = final + 1
  }
  return spans.length > 0 ? spans : [{ text: '', color: DEFAULT_FG, bold: false }]
}

export function parseAnsi(text: string): ParsedLine[] {
  return text.split('\n').map(parseLine)
}
