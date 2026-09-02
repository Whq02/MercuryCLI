import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const CELL_W = 8, CELL_H = 16, FONT = 13
// The capture ground mirrors mercuryPalette NIGHT so
// renders show the same deep teal-navy the deployed terminal profile paints.
// Light-FAMILY captures (MERCURY_THEME_PIN=light*) override via VSHOT_BG/FG —
// a light theme is designed for a light terminal profile; painting it over
// the dark capture ground would mis-verify contrast.
const BG = process.env.VSHOT_BG ?? '#0d181b', FG = process.env.VSHOT_FG ?? '#e8e0d8'
// Minimal named-color table; truecolor arrives as a 6-hex string, used directly.
const NAMED: Record<string, string> = {
  black: '#000000', red: '#c0392b', green: '#27ae60', yellow: '#d4a017', brown: '#d4a017',
  blue: '#2e6da4', magenta: '#9b59b6', cyan: '#3f7e96', white: '#ccd6d0',
  brightblack: '#5e6d68', brightred: '#de4a35', brightgreen: '#2ecc71',
  brightyellow: '#f1c40f', brightbrown: '#f1c40f', brightblue: '#5dade2', brightmagenta: '#bb8fce',
  brightcyan: '#7fd6e6', brightwhite: '#ffffff',
}
function hex(c: string, fallback: string): string {
  if (!c || c === 'default') return fallback
  if (/^[0-9a-fA-F]{6}$/.test(c)) return '#' + c
  return NAMED[c.toLowerCase()] ?? fallback
}
const esc = (s: string) => s.replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]!))

export async function gridToPng(gridJsonPath: string, outPng: string) {
  const { grid, cols, rows } = JSON.parse(readFileSync(gridJsonPath, 'utf8'))
  const W = cols * CELL_W, H = rows * CELL_H
  let rects = '', texts = ''
  grid.forEach((line: any[], y: number) => line.forEach((cell, x) => {
    const bg = hex(cell.rev ? cell.fg : cell.bg, BG)
    const fg = hex(cell.rev ? cell.bg : cell.fg, FG)
    if (bg !== BG) rects += `<rect x="${x * CELL_W}" y="${y * CELL_H}" width="${CELL_W}" height="${CELL_H}" fill="${bg}"/>`
    const ch = cell.c
    // Half-block glyphs (▀/▄) are SPRITE pixels, not text — render them as precise
    // top/bottom rects so a Forge sprite previews at true terminal fidelity instead
    // of the font's approximate glyph (which stretches/compresses it).
    if (ch === '▀') {
      if (fg !== BG) rects += `<rect x="${x * CELL_W}" y="${y * CELL_H}" width="${CELL_W}" height="${CELL_H / 2}" fill="${fg}"/>`
    } else if (ch === '▄') {
      if (fg !== BG) rects += `<rect x="${x * CELL_W}" y="${y * CELL_H + CELL_H / 2}" width="${CELL_W}" height="${CELL_H / 2}" fill="${fg}"/>`
    } else if (ch && ch !== ' ') {
      texts += `<text x="${x * CELL_W}" y="${y * CELL_H + FONT}" fill="${fg}"${cell.bold ? ' font-weight="bold"' : ''}>${esc(ch)}</text>`
    }
  }))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${BG}"/><style>text{font-family:'SF Mono',Menlo,monospace;font-size:${FONT}px}</style>${rects}${texts}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(outPng)
  return { path: outPng, width: W, height: H }
}
