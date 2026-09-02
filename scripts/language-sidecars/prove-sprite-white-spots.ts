#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-sprite-white-spots.ts
//  PROOF:
//  two deterministic defects in spriteToAnsi, both driven through the REAL
//  pipeline on synthetic sprites built for the failure geometry:
//    A. TOP-EDGE DEFAULT-FG SPECKS: a cell whose TOP pixel is background and
//       BOTTOM is sprite would otherwise emit ▀ with NO foreground — the upper half
//       painted in the terminal's default (light) fg. Now that cell emits ▄
//       (fg = bottom pixel, top = terminal bg). Oracle: no ▀ in any output
//       line without an explicit 38;2 fg ahead of it; top-edge cells are ▄.
//    B. WHITE-MATTE FLOOD: only border-connected near-white drops to the
//       terminal bg; warm-white AA fringe on the matte side drops too; a
//       genuinely white INTERIOR region (the cat's chest) RENDERS.
//  Run:  ~/.bun/bin/bun run scripts/language-sidecars/prove-sprite-white-spots.ts
// ============================================================================
import sharp from 'sharp'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { spriteToAnsi } = await import('../../src/services/visual/spriteToAnsi.js')
const ESC = String.fromCharCode(27)

// ── Sprite 1: a dark disc on a WHITE matte with a warm-white AA ring, plus a
//    pure-white interior square (the "chest"). 64×64, no alpha (matted). ──
const W = 64
const px = Buffer.alloc(W * W * 3)
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    const dx = x - 32, dy = y - 32
    const d = Math.sqrt(dx * dx + dy * dy)
    let r = 255, g = 255, b = 255 // matte
    if (d < 20) { r = 40; g = 30; b = 25 } // dark body
    else if (d < 22) { r = 250; g = 242; b = 233 } // warm-white AA fringe (the old >238-flat MISS: b<238)
    if (x >= 28 && x <= 36 && y >= 36 && y <= 44) { r = 252; g = 250; b = 248 } // interior white "chest"
    px[i] = r; px[i + 1] = g; px[i + 2] = b
  }
}
const matted = await sharp(px, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer()
const out = await spriteToAnsi(matted, 32)

section('A. no default-foreground upper halves (the speck class)')
// Every ▀ must be preceded on its line by an explicit truecolor fg (38;2) with
// no intervening reset; the topBg case must emit ▄ instead.
let nakedUpper = 0
for (const line of out.lines) {
  const cells = line.split('▀').slice(0, -1)
  let carry = ''
  for (const seg of cells) {
    const s = carry + seg
    const lastFg = s.lastIndexOf('38;2;')
    const lastReset = Math.max(s.lastIndexOf(`${ESC}[0m`), s.lastIndexOf(`${ESC}[m`))
    if (lastFg === -1 || lastReset > lastFg) nakedUpper++
    carry = s
  }
}
check('zero ▀ cells without an explicit fg', nakedUpper === 0, `naked=${nakedUpper}`)
check('top-silhouette cells use ▄ (lower half-block)', out.lines.some(l => l.includes('▄')))
check('▄ cells carry fg + terminal-bg reset (49)', out.lines.every(l => !l.includes('▄') || /\[49m\x1b\[38;2;[0-9;]+m▄/.test(l)))

section('B. flood matte — outside drops, fringe drops, interior white renders')
const joined = out.lines.join('\n')
// The matte + AA fringe must not paint near-white cells: no truecolor fg/bg
// whose r,g,b are ALL ≥222 AND near-neutral EXCEPT inside the chest rows.
const colorRe = /\[(?:38|48);2;(\d+);(\d+);(\d+)m/g
let paintedNearWhite = 0
let m: RegExpExecArray | null
while ((m = colorRe.exec(joined)) !== null) {
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const mn = Math.min(r, g, b), mx = Math.max(r, g, b)
  if (mn >= 222 && mx - mn <= 32) paintedNearWhite++
}
check('interior white survives (some near-white IS painted — the chest)', paintedNearWhite > 0, `painted=${paintedNearWhite}`)
// The chest is 9×9 px of a 64px sprite fitted to 32 cols ⇒ ≈4-5 cells wide ×
// ~2 rows ⇒ bounded. If the matte leaked, near-white counts would explode
// toward the full disc circumference / matte area.
check('but bounded — the matte + fringe did NOT paint', paintedNearWhite <= 24, `painted=${paintedNearWhite}`)
const firstLine = out.lines[0] ?? ''
check('first row (pure matte) is all terminal-bg spaces', /^(?:\x1b\[0m )+\x1b\[0m$/.test(firstLine))

// ── Sprite 2: transparent-PNG path unchanged (alpha matte still drops). ──
section('C. alpha-matte sprite still clean (regression guard)')
const px2 = Buffer.alloc(16 * 16 * 4)
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4
    const on = x >= 4 && x < 12 && y >= 4 && y < 12
    px2[i] = 200; px2[i + 1] = 60; px2[i + 2] = 40; px2[i + 3] = on ? 255 : 0
  }
}
const alphaPng = await sharp(px2, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer()
const out2 = await spriteToAnsi(alphaPng, 16)
check('alpha sprite renders body cells', out2.lines.some(l => l.includes('38;2;')))
check('alpha sprite has no naked-▀ cells either', out2.lines.every(l => {
  const cells = l.split('▀').slice(0, -1)
  let carry = ''
  for (const seg of cells) {
    const s = carry + seg
    const lastFg = s.lastIndexOf('38;2;')
    const lastReset = Math.max(s.lastIndexOf(`${ESC}[0m`), s.lastIndexOf(`${ESC}[m`))
    if (lastFg === -1 || lastReset > lastFg) return false
    carry = s
  }
  return true
}))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ white spots — ALL CHECKS PASS')
