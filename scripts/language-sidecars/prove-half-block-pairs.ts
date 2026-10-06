process.env.FORCE_COLOR = '3'
const sharp = (await import('sharp')).default
const chalk = (await import('chalk')).default
const { spriteToAnsi } = await import('../../src/services/visual/spriteToAnsi.js')
const { imageToCells } = await import('../../src/services/visual/imageDisplay.js')
const { rgbToXterm256 } = await import('../../src/ink/cell-grid.js')
const { _resetGroundForTest, markOriginalGroundQuerySent, noteOriginalGroundReply, terminalGround } = await import('../../src/utils/cockpit/oasisBg.js')

const ESC = String.fromCharCode(27)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const show = (s: string): string => JSON.stringify(s.replace(/\x1b/g, 'ESC'))

const TOP = { r: 10, g: 20, b: 30 }
const BOTTOM = { r: 200, g: 210, b: 220 }
const pair = (rows: number, bottomAlpha = 255, topAlpha = 255): Buffer => {
  const px: number[] = []
  for (let y = 0; y < rows; y++) {
    const top = y % 2 === 0
    const c = top ? TOP : BOTTOM
    px.push(c.r, c.g, c.b, top ? topAlpha : bottomAlpha)
  }
  return Buffer.from(px)
}
const png = async (rows: number, bottomAlpha = 255, topAlpha = 255): Promise<Buffer> =>
  sharp(pair(rows, bottomAlpha, topAlpha), { raw: { width: 1, height: rows, channels: 4 } }).png().toBuffer()

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

console.log('\n the ground KNOWN (the owner painted the canvas): a single-colour cell names the ground in its empty half, never ▀, never the 49 reset')
{
  _resetGroundForTest()
  check('the owner starts unknown', terminalGround().state === 'unknown', JSON.stringify(terminalGround()))
  markOriginalGroundQuerySent()
  noteOriginalGroundReply('rgb:0000/0000/0000', () => {})
  const ground = terminalGround()
  check('the warm road painted the canvas (NIGHT)', ground.state === 'painted' && ground.color === '#0d181b', JSON.stringify(ground))
  const G = { r: 13, g: 24, b: 27 }
  const topOnly = await spriteToAnsi(await png(2, 0), 1)
  const topRow = topOnly.lines[0] ?? ''
  check('spriteToAnsi: a top pixel over a transparent bottom goes out as ▄ with the pixel as the background and the ground as the glyph', topRow.includes(`${ESC}[48;2;${TOP.r};${TOP.g};${TOP.b}m${ESC}[38;2;${G.r};${G.g};${G.b}m▄`) && !topRow.includes('▀') && !topRow.includes('[49m'), show(topRow))
  const bottomOnly = await spriteToAnsi(await png(2, 255, 0), 1)
  const bottomRow = bottomOnly.lines[0] ?? ''
  check('spriteToAnsi: a transparent top over a bottom pixel goes out as ▄ with the ground named as the background and the pixel as the glyph', bottomRow.includes(`${ESC}[48;2;${G.r};${G.g};${G.b}m${ESC}[38;2;${BOTTOM.r};${BOTTOM.g};${BOTTOM.b}m▄`) && !bottomRow.includes('[49m'), show(bottomRow))
  const both = await spriteToAnsi(await png(2), 1)
  check('spriteToAnsi: a painted pair is unchanged by the ground', (both.lines[0] ?? '').includes(twoColourCell), show(both.lines[0] ?? ''))
  const odd = await imageToCells(await png(3), 1, 2)
  const lines = odd.split('\n')
  check('imageToCells: the odd last row goes out as ▄ with the pixel as the background and the ground as the glyph', lines.length === 2 && lines[1]!.includes(`${ESC}[48;2;${TOP.r};${TOP.g};${TOP.b}m${ESC}[38;2;${G.r};${G.g};${G.b}m▄`) && !odd.includes('▀'), show(odd))
  chalk.level = 2
  const reducedOdd = await imageToCells(await png(3), 1, 2)
  chalk.level = 3
  check('imageToCells at 256 colours: the odd last row carries the pixel and the ground at their nearest indexes', reducedOdd.split('\n')[1]!.includes(`${ESC}[48;5;${rgbToXterm256(TOP.r, TOP.g, TOP.b)}m${ESC}[38;5;${rgbToXterm256(G.r, G.g, G.b)}m▄`) && !reducedOdd.includes('[38;2;'), show(reducedOdd))
  _resetGroundForTest()
  const forgotten = await spriteToAnsi(await png(2, 0), 1)
  check('the ground forgotten: the top-only cell is ▀ on the terminal ground again (never a guessed colour)', (forgotten.lines[0] ?? '').includes(`${ESC}[38;2;${TOP.r};${TOP.g};${TOP.b}m${ESC}[49m▀`), show(forgotten.lines[0] ?? ''))
}

console.log(`\n${failures === 0 ? '✅ half-block pairs GREEN' : `❌ half-block pairs RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
