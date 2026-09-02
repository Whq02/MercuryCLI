#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-recess-law.ts — LUSTRE L1: the focused-layer recess law
//  at its owners (unit tier; the behavioral oracle is render-surface-claim).
//
//    §1 the color math: mixToward folds toward the canvas at RECESS_MIX;
//       the xterm-256 bridge round-trips the cube and gray ramps
//    §2 StylePool.withRecess: 24-bit + 256 fg/bg fold toward the canvas;
//       named 16-color codes pass through untouched; colorless text takes
//       the pre-mixed default ink; IDEMPOTENT (a recess derivation maps to
//       itself — steady frames blit recessed cells back through the pass);
//       a changed target invalidates the derivation cache; a null target is
//       identity
//    §3 the pass: cells outside the elevated rects remap, cells inside stay,
//       empty cells are skipped, and a second pass over the same screen
//       writes NOTHING (the damage-honesty law: steady frames cost zero)
//    §4 policy: MERCURY_RECESS=0 closes the gate; 16-color families resolve
//       a null target (ansi:* names can't host a derived dim); the policy
//       module consults the boot-latched NO_COLOR verdict
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-recess-law.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
// chalk resolves capability at import: pin truecolor BEFORE the dynamic
// imports so the policy math is deterministic in a piped prover run.
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' Recess law — LUSTRE L1 focused-layer backdrop')
console.log('============================================================')

const grid = await import('../../src/ink/cell-grid.js')
const layer = await import('../../src/ink/recessLayer.js')
const { nodeCache } = await import('../../src/ink/node-cache.js')
const tokensMod = await import('../../src/utils/mercuryTokens.js')
const policy = await import('../../src/utils/cockpit/recessBackdrop.js')

const FG = (code: string): { type: 'ansi'; code: string; endCode: string } => ({
  type: 'ansi', code, endCode: '\x1b[39m',
})
const BG = (code: string): { type: 'ansi'; code: string; endCode: string } => ({
  type: 'ansi', code, endCode: '\x1b[49m',
})
const CANVAS: [number, number, number] = [13, 24, 27] // NIGHT
const INK: [number, number, number] = [237, 232, 221] // IVORY
const CFG = { canvas: CANVAS, ink: INK, quantize256: false }

section('§1 — mix + xterm-256 bridge')
{
  check('RECESS_MIX is one emphasis step (0 < mix < 1)', grid.RECESS_MIX > 0 && grid.RECESS_MIX < 1)
  const [r, g, b] = grid.mixToward([113, 128, 123], CANVAS, 0.5)
  check('mixToward folds FAINT halfway to NIGHT', r === 63 && g === 76 && b === 75, `#${r.toString(16)}${g.toString(16)}${b.toString(16)}`)
  check('mixToward t=0 is identity', grid.mixToward([10, 20, 30], CANVAS, 0).join(',') === '10,20,30')
  const cube = grid.xterm256ToRgb(196) // pure red in the cube
  check('xterm 196 → rgb(255,0,0)', cube !== null && cube.join(',') === '255,0,0')
  check('rgb(255,0,0) → xterm 196', grid.rgbToXterm256(255, 0, 0) === 196)
  const gray = grid.xterm256ToRgb(240)
  check('gray-ramp index survives the round trip', gray !== null && grid.rgbToXterm256(gray[0], gray[1], gray[2]) === 240)
  check('16-color names refuse the bridge', grid.xterm256ToRgb(3) === null)
}

section('§2 — StylePool.withRecess')
{
  const pool = new grid.StylePool()
  pool.setRecessTransform(CFG)

  const bright = pool.intern([FG('\x1b[38;2;237;232;221m')])
  const dim = pool.withRecess(bright)
  check('24-bit fg folds toward the canvas', pool.get(dim).some(c => c.code === '\x1b[38;2;125;128;124m'), pool.get(dim).map(c => JSON.stringify(c.code)).join(' '))
  check('idempotent: a recess derivation maps to itself', pool.withRecess(dim) === dim)
  check('cached: the same base derives once', pool.withRecess(bright) === dim)

  const named = pool.intern([FG('\x1b[31m')])
  const namedOut = pool.withRecess(named)
  check('named 16-color fg passes through untouched', pool.get(namedOut).some(c => c.code === '\x1b[31m'))

  const colorless = pool.intern([])
  const colorlessOut = pool.withRecess(colorless)
  check(
    'colorless text takes the pre-mixed default ink',
    pool.get(colorlessOut).some(c => c.endCode === '\x1b[39m'),
    pool.get(colorlessOut).map(c => JSON.stringify(c.code)).join(' '),
  )

  const withBg = pool.intern([FG('\x1b[38;2;221;68;68m'), BG('\x1b[48;2;47;75;82m')])
  const withBgOut = pool.withRecess(withBg)
  check(
    'explicit bg folds toward the canvas too',
    pool.get(withBgOut).some(c => c.code.startsWith('\x1b[48;2;30;')),
    pool.get(withBgOut).map(c => JSON.stringify(c.code)).join(' '),
  )

  const pool256 = new grid.StylePool()
  pool256.setRecessTransform({ ...CFG, quantize256: true })
  const b256 = pool256.intern([FG('\x1b[38;5;196m')])
  const d256 = pool256.withRecess(b256)
  check('256 fg re-quantizes inside 38;5', pool256.get(d256).some(c => /^\x1b\[38;5;\d+m$/.test(c.code) && c.code !== '\x1b[38;5;196m'))

  pool.setRecessTransform(null)
  check('null target is identity', pool.withRecess(bright) === bright)
  pool.setRecessTransform(CFG)
  const again = pool.withRecess(bright)
  check('re-arming re-derives (cache invalidated by target change)', pool.get(again).some(c => c.code === '\x1b[38;2;125;128;124m'))
}

section('§3 — the pass over a synthetic screen')
{
  const pool = new grid.StylePool()
  const chars = new grid.CharPool()
  const links = new grid.HyperlinkPool()
  const screen = grid.createScreen(10, 4, pool, chars, links)
  const bright = pool.intern([FG('\x1b[38;2;237;232;221m')])
  // Row 0: backdrop text. Row 2: inside the elevated rect.
  for (let x = 0; x < 5; x++) {
    grid.setCellAt(screen, x, 0, { char: 'a', styleId: bright, width: 0, hyperlink: undefined })
    grid.setCellAt(screen, x, 2, { char: 'b', styleId: bright, width: 0, hyperlink: undefined })
  }
  pool.setRecessTransform(CFG)
  const rect = { x: 0, y: 2, width: 10, height: 2 }
  const changed = grid.remapStylesOutside(screen, [rect], id => pool.withRecess(id))
  check('outside cells remapped (5 backdrop cells)', changed === 5, String(changed))
  const out = grid.cellAt(screen, 0, 0)!
  check('backdrop cell wears the recessed style', pool.get(out.styleId).some(c => c.code === '\x1b[38;2;125;128;124m'))
  const inside = grid.cellAt(screen, 0, 2)!
  check('elevated cell untouched', inside.styleId === bright)
  const second = grid.remapStylesOutside(screen, [rect], id => pool.withRecess(id))
  check('second pass writes NOTHING (steady-frame zero)', second === 0, String(second))

  // The layer store: registrants + target drive activity; a fabricated node
  // with a committed rect exercises the real applyRecessPass.
  const fakeEl = {} as never
  nodeCache.set(fakeEl, { x: 0, y: 2, width: 10, height: 2 })
  const unregister = layer.registerElevatedSurface(fakeEl)
  layer.setRecessTarget(CFG)
  check('recessActive with a registrant + target', layer.recessActive())
  const passChanged = layer.applyRecessPass(screen, pool)
  check('applyRecessPass is steady-zero over an already-recessed screen', passChanged === 0, String(passChanged))
  unregister()
  check('unregister ends activity', !layer.recessActive())
  layer.setRecessTarget(null)
}

section('§4 — policy gates')
{
  const saved = process.env.MERCURY_RECESS
  process.env.MERCURY_RECESS = '0'
  check('MERCURY_RECESS=0 closes the gate', !policy.recessBackdropEnabled())
  if (saved === undefined) delete process.env.MERCURY_RECESS
  else process.env.MERCURY_RECESS = saved

  const darkTokens = tokensMod.resolveMercuryTokens('dark', '#DD4444')
  const target = policy.recessTargetFor(darkTokens)
  check('dark family resolves a target toward NIGHT', target !== null && target.canvas.join(',') === '13,24,27')
  const ansiTokens = tokensMod.resolveMercuryTokens('dark-ansi', '#DD4444')
  check('16-color family resolves NULL (no derived dim on names)', policy.recessTargetFor(ansiTokens) === null)

  const policySrc = readFileSync(join(ROOT, 'src/utils/cockpit/recessBackdrop.ts'), 'utf-8')
  check('policy consults the boot-latched NO_COLOR verdict', /CHALK_DISABLED_FOR_NO_COLOR/.test(policySrc))
  check('policy requires ≥256-color capability', /chalk\.level >= 2/.test(policySrc))
  const rendererSrc = readFileSync(join(ROOT, 'src/ink/renderer.ts'), 'utf-8')
  check('the pass runs on alt-screen frames only', /if \(options\.altScreen\) \{[\s\S]*?applyRecessPass\(renderedScreen, stylePool\)/.test(rendererSrc))
}

section('§5 — deactivation + growth (the verify-wave laws)')
{
  const layerSrc = readFileSync(join(ROOT, 'src/ink/recessLayer.ts'), 'utf-8')
  // THE UNREGISTER INVALIDATES: deactivation must never rely on a sibling
  // overlay's pop — an elevated in-flow Dialog with no overlay of its own
  // left the whole screen dimmed forever, and the next elevation re-derived
  // recess-of-recess on the stale cells (the progressive-fade ghost).
  check(
    'unregister invalidates the previous frame while a target is live',
    /registrants\.delete\(el\)\s*\n\s*if \(target !== null\) \{\s*\n\s*instances\.get\(process\.stdout\)\?\.invalidatePrevFrame\(\)/.test(layerSrc),
  )
  check(
    'a REAL target change with live registrants also invalidates (mid-modal theme flip)',
    /const changed =[\s\S]*?if \(changed && hadWork\) \{\s*\n\s*instances\.get\(process\.stdout\)\?\.invalidatePrevFrame\(\)/.test(layerSrc),
  )
  // THE GROWTH GUARD: the packed style budget is finite and intern never
  // frees — near the ceiling the derivation degrades to identity instead of
  // letting packWord1 silently truncate into the wrong style.
  const gridSrc = readFileSync(join(ROOT, 'src/ink/cell-grid.ts'), 'utf-8')
  check(
    'withRecess degrades to identity near the style-pool ceiling',
    /if \(this\.styles\.length >= 16000\) \{[\s\S]*?return baseId/.test(gridSrc),
  )
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
