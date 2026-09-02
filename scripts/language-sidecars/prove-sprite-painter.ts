// Proof: spriteToAnsi (the half-block render that ships in the binary via the
// runtime sharp dep) loads, converts a PNG to half-block truecolor ANSI, and
// emits no stray control bytes other than ESC.
import sharp from 'sharp'
import { spriteToAnsi } from '../../src/services/visual/spriteToAnsi.js'

const ESC = String.fromCharCode(27)

let failed = 0
function check(name: string, cond: boolean): void {
  if (!cond) {
    failed++
    console.error('  ✗ ' + name)
  }
}

// A tiny solid TERRA-red sprite (no /tmp dependency — generated in-proof).
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

// No stray control bytes other than ESC (0x1b); lines must not contain newlines.
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

if (failed) {
  console.error('\n' + failed + ' sprite-painter check(s) FAILED')
  process.exit(1)
}
console.log('sprite-painter: spriteToAnsi half-block render OK (' + cols + 'x' + rows + ')')
