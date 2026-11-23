#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Recess law — LUSTRE L1 focused-layer backdrop')
console.log('============================================================')

const grid = await import('../../src/screen/renderer/cell-grid.js')
const layer = await import('../../src/screen/renderer/recessLayer.js')
const { nodeCache } = await import('../../src/screen/renderer/node-cache.js')
const tokensMod = await import('../../src/screen/theme/mercuryTokens.js')
const policy = await import('../../src/screen/cockpit/recessBackdrop.js')

const FG = (code: string): { type: 'ansi'; code: string; endCode: string } => ({
  type: 'ansi', code, endCode: '\x1b[39m',
})
const BG = (code: string): { type: 'ansi'; code: string; endCode: string } => ({
  type: 'ansi', code, endCode: '\x1b[49m',
})
const CANVAS: [number, number, number] = [13, 24, 27]
const INK: [number, number, number] = [237, 232, 221]
const CFG = { canvas: CANVAS, ink: INK, quantize256: false }

section('§1 — mix + xterm-256 bridge')
{
  check('RECESS_MIX is one emphasis step (0 < mix < 1)', grid.RECESS_MIX > 0 && grid.RECESS_MIX < 1, '', 'RECESS_MIX in src/screen/renderer/cell-grid.ts must stay strictly between 0 and 1')
  const [r, g, b] = grid.mixToward([113, 128, 123], CANVAS, 0.5)
  check('mixToward folds FAINT halfway to NIGHT', r === 63 && g === 76 && b === 75, `#${r.toString(16)}${g.toString(16)}${b.toString(16)}`, 'mixToward in src/screen/renderer/cell-grid.ts must blend each channel linearly toward the target and round')
  check('mixToward t=0 is identity', grid.mixToward([10, 20, 30], CANVAS, 0).join(',') === '10,20,30', '', 'mixToward in src/screen/renderer/cell-grid.ts must return the source colour at t=0')
  const cube = grid.xterm256ToRgb(196)
  check('xterm 196 → rgb(255,0,0)', cube !== null && cube.join(',') === '255,0,0', '', 'xterm256ToRgb in src/screen/renderer/cell-grid.ts must map the colour-cube index 196 to 255,0,0')
  check('rgb(255,0,0) → xterm 196', grid.rgbToXterm256(255, 0, 0) === 196, '', 'rgbToXterm256 in src/screen/renderer/cell-grid.ts must map 255,0,0 to the colour-cube index 196')
  const gray = grid.xterm256ToRgb(240)
  check('gray-ramp index survives the round trip', gray !== null && grid.rgbToXterm256(gray[0], gray[1], gray[2]) === 240, '', 'xterm256ToRgb and rgbToXterm256 in src/screen/renderer/cell-grid.ts must agree on the grey ramp')
  check('16-color names refuse the bridge', grid.xterm256ToRgb(3) === null, '', 'xterm256ToRgb in src/screen/renderer/cell-grid.ts must return null for the 16 named colours')
}

section('§2 — StylePool.withRecess')
{
  const pool = new grid.StylePool()
  pool.setRecessTransform(CFG)

  const bright = pool.intern([FG('\x1b[38;2;237;232;221m')])
  const dim = pool.withRecess(bright)
  check('24-bit fg folds toward the canvas', pool.get(dim).some(c => c.code === '\x1b[38;2;125;128;124m'), pool.get(dim).map(c => JSON.stringify(c.code)).join(' '), 'StylePool.withRecess in src/screen/renderer/cell-grid.ts must fold a 24-bit foreground toward the canvas by RECESS_MIX')
  check('idempotent: a recess derivation maps to itself', pool.withRecess(dim) === dim, '', 'StylePool.withRecess in src/screen/renderer/cell-grid.ts must return an already recessed style id unchanged')
  check('cached: the same base derives once', pool.withRecess(bright) === dim, '', 'StylePool.withRecess in src/screen/renderer/cell-grid.ts must cache the derived id per base id')

  const named = pool.intern([FG('\x1b[31m')])
  const namedOut = pool.withRecess(named)
  check('named 16-color fg passes through untouched', pool.get(namedOut).some(c => c.code === '\x1b[31m'), '', 'StylePool.withRecess in src/screen/renderer/cell-grid.ts must leave a named 16-colour foreground as it is')

  const colorless = pool.intern([])
  const colorlessOut = pool.withRecess(colorless)
  check(
    'colorless text takes the pre-mixed default ink',
    pool.get(colorlessOut).some(c => c.endCode === '\x1b[39m'),
    pool.get(colorlessOut).map(c => JSON.stringify(c.code)).join(' '),
    'StylePool.setRecessTransform and withRecess in src/screen/renderer/cell-grid.ts must add a pre-mixed default ink foreground to a style with no colour',
  )

  const withBg = pool.intern([FG('\x1b[38;2;221;68;68m'), BG('\x1b[48;2;47;75;82m')])
  const withBgOut = pool.withRecess(withBg)
  check(
    'explicit bg folds toward the canvas too',
    pool.get(withBgOut).some(c => c.code.startsWith('\x1b[48;2;30;')),
    pool.get(withBgOut).map(c => JSON.stringify(c.code)).join(' '),
    'StylePool.withRecess in src/screen/renderer/cell-grid.ts must fold an explicit 48;2 background toward the canvas too',
  )

  const pool256 = new grid.StylePool()
  pool256.setRecessTransform({ ...CFG, quantize256: true })
  const b256 = pool256.intern([FG('\x1b[38;5;196m')])
  const d256 = pool256.withRecess(b256)
  check('256 fg re-quantizes inside 38;5', pool256.get(d256).some(c => /^\x1b\[38;5;\d+m$/.test(c.code) && c.code !== '\x1b[38;5;196m'), '', 'StylePool.withRecess in src/screen/renderer/cell-grid.ts must re-quantize a 38;5 foreground to a different 256-colour index when quantize256 is on')

  pool.setRecessTransform(null)
  check('null target is identity', pool.withRecess(bright) === bright, '', 'StylePool.setRecessTransform in src/screen/renderer/cell-grid.ts must make withRecess the identity when the target is null')
  pool.setRecessTransform(CFG)
  const again = pool.withRecess(bright)
  check('re-arming re-derives (cache invalidated by target change)', pool.get(again).some(c => c.code === '\x1b[38;2;125;128;124m'), '', 'StylePool.setRecessTransform in src/screen/renderer/cell-grid.ts must clear the derived-style cache when the target changes')
}

section('§3 — the pass over a synthetic screen')
{
  const pool = new grid.StylePool()
  const chars = new grid.CharPool()
  const links = new grid.HyperlinkPool()
  const screen = grid.createScreen(10, 4, pool, chars, links)
  const bright = pool.intern([FG('\x1b[38;2;237;232;221m')])
  for (let x = 0; x < 5; x++) {
    grid.setCellAt(screen, x, 0, { char: 'a', styleId: bright, width: 0, hyperlink: undefined })
    grid.setCellAt(screen, x, 2, { char: 'b', styleId: bright, width: 0, hyperlink: undefined })
  }
  pool.setRecessTransform(CFG)
  const rect = { x: 0, y: 2, width: 10, height: 2 }
  const changed = grid.remapStylesOutside(screen, [rect], id => pool.withRecess(id))
  check('outside cells remapped (5 backdrop cells)', changed === 5, String(changed), 'remapStylesOutside in src/screen/renderer/cell-grid.ts must remap every cell outside the given rectangles and count the cells it changed')
  const out = grid.cellAt(screen, 0, 0)!
  check('backdrop cell wears the recessed style', pool.get(out.styleId).some(c => c.code === '\x1b[38;2;125;128;124m'), '', 'remapStylesOutside in src/screen/renderer/cell-grid.ts must write the remapped style id into cells outside the rectangles')
  const inside = grid.cellAt(screen, 0, 2)!
  check('elevated cell untouched', inside.styleId === bright, '', 'remapStylesOutside in src/screen/renderer/cell-grid.ts must not touch cells inside the rectangles')
  const second = grid.remapStylesOutside(screen, [rect], id => pool.withRecess(id))
  check('second pass writes NOTHING (steady-frame zero)', second === 0, String(second), 'remapStylesOutside in src/screen/renderer/cell-grid.ts must count only cells whose style id changed, so a repeat pass returns 0')

  const fakeEl = {} as never
  nodeCache.set(fakeEl, { x: 0, y: 2, width: 10, height: 2 })
  const unregister = layer.registerElevatedSurface(fakeEl)
  layer.setRecessTarget(CFG)
  check('recessActive with a registrant + target', layer.recessActive(), '', 'recessActive in src/screen/renderer/recessLayer.ts must be true while an elevated surface is registered and a target is set')
  const passChanged = layer.applyRecessPass(screen, pool)
  check('applyRecessPass is steady-zero over an already-recessed screen', passChanged === 0, String(passChanged), 'applyRecessPass in src/screen/renderer/recessLayer.ts must return 0 over a screen that is already recessed')
  unregister()
  check('unregister ends activity', !layer.recessActive(), '', 'the function registerElevatedSurface returns, in src/screen/renderer/recessLayer.ts, must end recessActive when called')
  layer.setRecessTarget(null)
}

section('§4 — policy gates')
{
  const saved = process.env.MERCURY_RECESS
  process.env.MERCURY_RECESS = '0'
  check('MERCURY_RECESS=0 closes the gate', !policy.recessBackdropEnabled(), '', 'recessBackdropEnabled in src/screen/cockpit/recessBackdrop.ts must return false when MERCURY_RECESS is 0')
  if (saved === undefined) delete process.env.MERCURY_RECESS
  else process.env.MERCURY_RECESS = saved

  const darkTokens = tokensMod.resolveMercuryTokens('dark', '#DD4444')
  const target = policy.recessTargetFor(darkTokens)
  check('dark family resolves a target toward NIGHT', target !== null && target.canvas.join(',') === '13,24,27', '', 'recessTargetFor in src/screen/cockpit/recessBackdrop.ts must return a target whose canvas is the NIGHT colour for the dark theme family')
  const namedInkTokens = { ...darkTokens, textPrimary: 'ansi:white' } as typeof darkTokens
  check('unparseable ink resolves NULL (no derived dim on names — every resolved theme is hex now, the guard stays)', policy.recessTargetFor(namedInkTokens) === null, '', 'recessTargetFor in src/screen/cockpit/recessBackdrop.ts must return null when textPrimary is not a parseable hex colour')

}


console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
