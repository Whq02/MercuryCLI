process.env.FORCE_COLOR = '3'
const sharp = (await import('sharp')).default
const chalk = (await import('chalk')).default
const { spriteToAnsi } = await import('../../src/services/visual/spriteToAnsi.js')
const { imageToCells } = await import('../../src/services/visual/imageDisplay.js')
const { rgbToXterm256 } = await import('../../src/ink/cell-grid.js')

const ESC = String.fromCharCode(27)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const show = (s: string): string => JSON.stringify(s.replace(/\x1b/g, 'ESC'))

const TOP = { r: 10, g: 20, b: 30 }
const BOTTOM = { r: 200, g: 210, b: 220 }
const pair = (rows: number, bottomAlpha = 255): Buffer => {
  const px: number[] = []
  for (let y = 0; y < rows; y++) {
    const top = y % 2 === 0
    const c = top ? TOP : BOTTOM
    px.push(c.r, c.g, c.b, top ? 255 : bottomAlpha)
  }
  return Buffer.from(px)
}
const png = async (rows: number, bottomAlpha = 255): Promise<Buffer> =>
  sharp(pair(rows, bottomAlpha), { raw: { width: 1, height: rows, channels: 4 } }).png().toBuffer()

console.log('============================================================')
console.log(' the image painters — a cell with two pixels is the lower half-block, the colours swapped')
console.log('============================================================')

const twoColourCell = `${ESC}[48;2;${TOP.r};${TOP.g};${TOP.b}m${ESC}[38;2;${BOTTOM.r};${BOTTOM.g};${BOTTOM.b}m▄`
{
  const sprite = await spriteToAnsi(await png(2), 1)
  const row = sprite.lines[0] ?? ''
  check('spriteToAnsi: a top pixel over a bottom pixel goes out as ▄ with the top as the background and the bottom as the glyph', row.includes(twoColourCell), show(row))
  check('…never as ▀ with the bottom as the background', !row.includes('▀'), show(row))
  const topOnly = await spriteToAnsi(await png(2, 0), 1)
  const topRow = topOnly.lines[0] ?? ''
  check('spriteToAnsi: a top pixel over a transparent bottom keeps ▀ on the terminal ground', topRow.includes(`${ESC}[38;2;${TOP.r};${TOP.g};${TOP.b}m${ESC}[49m▀`), show(topRow))
}
{
  const cells = await imageToCells(await png(2), 1, 1)
  check('imageToCells: a top pixel over a bottom pixel goes out as ▄ with the top as the background and the bottom as the glyph', cells.includes(twoColourCell), show(cells))
  check('…never as ▀', !cells.includes('▀'), show(cells))
  const odd = await imageToCells(await png(3), 1, 2)
  const lines = odd.split('\n')
  check('imageToCells: an odd last row (a top pixel with nothing under it) keeps ▀ with the pixel as the glyph', lines.length === 2 && lines[1]!.includes(`${ESC}[38;2;${TOP.r};${TOP.g};${TOP.b}m▀`), show(odd))
  chalk.level = 2
  const reduced = await imageToCells(await png(2), 1, 1)
  chalk.level = 3
  check('imageToCells at 256 colours: the same cell, each half at its nearest index', reduced.includes(`${ESC}[48;5;${rgbToXterm256(TOP.r, TOP.g, TOP.b)}m${ESC}[38;5;${rgbToXterm256(BOTTOM.r, BOTTOM.g, BOTTOM.b)}m▄`) && !reduced.includes('[38;2;'), show(reduced))
}

console.log(`\n${failures === 0 ? '✅ half-block pairs GREEN' : `❌ half-block pairs RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
