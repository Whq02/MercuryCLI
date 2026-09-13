process.env.FORCE_COLOR = '3'
const sharp = (await import('sharp')).default
const chalk = (await import('chalk')).default
const { rgbToXterm256 } = await import('../../src/ink/cell-grid.js')
const { spriteToAnsi } = await import('../../src/services/visual/spriteToAnsi.js')

const ESC = String.fromCharCode(27)

let failed = 0
function check(name: string, cond: boolean): void {
  if (!cond) {
    failed++
    console.error('  ✗ ' + name)
  }
}

const png = await sharp({
  create: { width: 6, height: 6, channels: 4, background: { r: 222, g: 74, b: 53, alpha: 1 } },
})
  .png()
  .toBuffer()

const { lines, cols, rows } = await spriteToAnsi(png, 8)

check('rows >= 1 and one line per row', rows >= 1 && lines.length === rows)
check('cols within the requested bound', cols >= 1 && cols <= 8)
const joined = lines.join('')
check('uses the half-block glyph ▀', joined.includes('▀'))
check('uses a truecolor escape', joined.includes(ESC + '[38;2;') || joined.includes(ESC + '[48;2;'))

let strayControl = false
for (const ln of lines) {
  for (const ch of ln) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 && cp !== 0x1b) {
      strayControl = true
      break
    }
  }
}
check('no stray control bytes (only ESC)', !strayControl)

chalk.level = 2
const reduced = (await spriteToAnsi(png, 8)).lines.join('')
chalk.level = 3
check('at 256 colours no 24-bit escape leaves the renderer', !reduced.includes('[38;2;') && !reduced.includes('[48;2;'))
check(
  'at 256 colours the cells carry the nearest index of the pixel',
  reduced.includes(ESC + '[38;5;' + rgbToXterm256(222, 74, 53) + 'm'),
)

if (failed) {
  console.error('\n' + failed + ' sprite-painter check(s) FAILED')
  process.exit(1)
}
console.log('sprite-painter: spriteToAnsi half-block render OK (' + cols + 'x' + rows + ')')
