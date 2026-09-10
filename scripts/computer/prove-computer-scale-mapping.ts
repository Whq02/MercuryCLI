#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, HOME, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'

const { pointOfPixel, pixelOfPoint } = await import('../../src/tools/ComputerTool/screenMap.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { pngDimensions } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const { DESKTOP_SHOTS_KEEP } = await import('../../src/services/desktop/desktopSession.ts')
type ScreenMap = import('../../src/tools/ComputerTool/screenMap.ts').ScreenMap

const scratch = scratchDir('scale-mapping')
const map = (fields: Partial<ScreenMap>): ScreenMap => ({
  toolUseId: 'toolu_map',
  display: 0,
  displayId: 'fixture-1',
  originX: 0,
  originY: 0,
  pointWidth: 1440,
  pointHeight: 900,
  imageWidth: 2880,
  imageHeight: 1800,
  capturedAt: 1,
  ...fields,
})
const point = (answer: unknown): string => JSON.stringify(answer)
const isOutside = (answer: unknown): boolean => (answer as { outside?: boolean }).outside === true

section('§1 pointOfPixel over the matrix')
{
  const unit = map({ pointWidth: 1920, pointHeight: 1080, imageWidth: 1920, imageHeight: 1080 })
  check('a 1× display maps a pixel to the same point', point(pointOfPixel(unit, 100, 50)) === point({ x: 100, y: 50 }), point(pointOfPixel(unit, 100, 50)))
  const retina = map({})
  check('a 2× display halves the pixel: (812, 300) → (406, 150)', point(pointOfPixel(retina, 812, 300)) === point({ x: 406, y: 150 }), point(pointOfPixel(retina, 812, 300)))
  const downscaled = map({ imageWidth: 1600, imageHeight: 1000 })
  check('a capture the budget downscaled maps by the ratio of the inlined image: (800, 500) of 1600×1000 → (720, 450)', point(pointOfPixel(downscaled, 800, 500)) === point({ x: 720, y: 450 }), point(pointOfPixel(downscaled, 800, 500)))
  const second = map({ display: 1, displayId: 'fixture-2', originX: 1440, originY: 0, pointWidth: 1920, pointHeight: 1080, imageWidth: 1920, imageHeight: 1080 })
  check('a second display at (1440, 0) adds its origin: (10, 10) → (1450, 10)', point(pointOfPixel(second, 10, 10)) === point({ x: 1450, y: 10 }))
  const left = map({ display: 1, displayId: 'fixture-2', originX: -1920, originY: 0, pointWidth: 1920, pointHeight: 1080, imageWidth: 1920, imageHeight: 1080 })
  check('a display to the left keeps its negative origin: (0, 0) → (-1920, 0) and (1919, 1079) → (-1, 1079)', point(pointOfPixel(left, 0, 0)) === point({ x: -1920, y: 0 }) && point(pointOfPixel(left, 1919, 1079)) === point({ x: -1, y: 1079 }), `${point(pointOfPixel(left, 0, 0))} ${point(pointOfPixel(left, 1919, 1079))}`)
  check('the corners: (0, 0) is the origin; the last pixel is inside', point(pointOfPixel(retina, 0, 0)) === point({ x: 0, y: 0 }) && !isOutside(pointOfPixel(retina, 2879, 1799)))
  check('outside: -1, imageWidth, imageHeight, NaN and Infinity', isOutside(pointOfPixel(retina, -1, 0)) && isOutside(pointOfPixel(retina, 2880, 0)) && isOutside(pointOfPixel(retina, 0, 1800)) && isOutside(pointOfPixel(retina, Number.NaN, 0)) && isOutside(pointOfPixel(retina, 0, Number.POSITIVE_INFINITY)))
  const outside = pointOfPixel(retina, 2880, 0) as { outside: true; imageWidth: number; imageHeight: number }
  check('an outside answer names the image size', outside.imageWidth === 2880 && outside.imageHeight === 1800, point(outside))
  check('rounding to the nearest integer point: (3, 3) → (2, 2) on 2×; (2, 2) → (1, 1)', point(pointOfPixel(retina, 3, 3)) === point({ x: 2, y: 2 }) && point(pointOfPixel(retina, 2, 2)) === point({ x: 1, y: 1 }), `${point(pointOfPixel(retina, 3, 3))} ${point(pointOfPixel(retina, 2, 2))}`)
  const back = pixelOfPoint(retina, { x: 406, y: 150 })
  check('pixelOfPoint is the inverse: (406, 150) → (812, 300)', back.x === 812 && back.y === 300, point(back))
  let roundTrips = true
  for (const [x, y] of [[0, 0], [1, 1], [2879, 1799], [1000, 777], [640, 480]] as Array<[number, number]>) {
    const p = pointOfPixel(retina, x, y)
    if (isOutside(p)) {
      roundTrips = false
      continue
    }
    const px = pixelOfPoint(retina, p as { x: number; y: number })
    if (Math.abs(px.x - x) > 1 || Math.abs(px.y - y) > 1) roundTrips = false
  }
  check('pixel → point → pixel lands within one pixel across the image', roundTrips)
  const backLeft = pixelOfPoint(left, { x: -1920, y: 0 })
  check('pixelOfPoint on the left display subtracts the negative origin', backLeft.x === 0 && backLeft.y === 0, point(backLeft))
}

section('§2 the screenshot result line spells both sizes and the map reads the inlined header')
{
  resetDesktopDriverForTest()
  const context = toolContext()
  const answer = await ComputerTool.call({ action: 'screenshot', label: 'scale' } as never, context, allowEverything, toolUseTurn('toolu_scale_shot', 'Computer', { action: 'screenshot', label: 'scale' }))
  const out = resultOf(answer)
  check('the screenshot succeeds', out.outcome === 'succeeded', out.result)
  const spelled = /display \d+ \((\d+)×(\d+) px of 1440×900 pt\)/.exec(out.result)
  check('the result line spells <w>×<h> px of <pw>×<ph> pt', spelled !== null, out.result)
  const diskHeader = out.imagePath && existsSync(out.imagePath) ? pngDimensions(readFileSync(out.imagePath)) : null
  check('the disk artifact is the full 2880×1800 capture', diskHeader?.width === 2880 && diskHeader?.height === 1800, JSON.stringify(diskHeader))
  const inlineHeader = out.inlinePath && existsSync(out.inlinePath) ? pngDimensions(readFileSync(out.inlinePath)) : diskHeader
  const screen = out.screen ?? {}
  check('the screen map\'s image size is the INLINED copy\'s header', inlineHeader !== null && screen.imageWidth === inlineHeader.width && screen.imageHeight === inlineHeader.height, `${JSON.stringify(screen)} vs ${JSON.stringify(inlineHeader)}`)
  check('the result line and the screen map agree', spelled !== null && Number(spelled[1]) === screen.imageWidth && Number(spelled[2]) === screen.imageHeight)
  check('the screen map carries the display\'s point size and origin', screen.pointWidth === 1440 && screen.pointHeight === 900 && screen.originX === 0 && screen.originY === 0)
  if (out.inlinePath) {
    check('the budget downscaled the inlined copy, so the map differs from the disk file', inlineHeader !== null && diskHeader !== null && inlineHeader.width < diskHeader.width)
  } else {
    console.log('  – the image budget kept the full capture inline on this route; the map reads the same header as the disk file')
  }
  check('the result line places the cursor in pixels of this image and names the application in front', /cursor \(\d+, \d+\)/.test(out.result) && out.result.includes('frontmost TextEdit'), out.result)
}

section('§3 desktop-shots is pruned to the newest files at each write')
{
  const scene = join(scratch, 'small.json')
  writeFileSync(scene, JSON.stringify({ displays: [{ index: 0, id: 'small', originX: 0, originY: 0, width: 320, height: 200, scale: 1, primary: true }] }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const shots = join(HOME, 'desktop-shots')
  mkdirSync(shots, { recursive: true })
  const base = Date.now() - 10_000_000
  for (let i = 0; i < DESKTOP_SHOTS_KEEP + 3; i++) writeFileSync(join(shots, `${base + i}-seeded.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const before = readdirSync(shots).length
  const context = toolContext()
  const first = resultOf(await ComputerTool.call({ action: 'screenshot', label: 'prune-1' } as never, context, allowEverything, toolUseTurn('toolu_prune_1', 'Computer', { action: 'screenshot' })))
  const second = resultOf(await ComputerTool.call({ action: 'screenshot', label: 'prune-2' } as never, context, allowEverything, toolUseTurn('toolu_prune_2', 'Computer', { action: 'screenshot' })))
  const after = readdirSync(shots)
  check(`after ${before} seeded files and two captures the directory holds at most ${DESKTOP_SHOTS_KEEP}`, after.length <= DESKTOP_SHOTS_KEEP, `${after.length} files`)
  check('the two newest captures survive the prune', first.imagePath !== undefined && second.imagePath !== undefined && existsSync(first.imagePath) && existsSync(second.imagePath))
  check('the oldest seeded file is gone', !existsSync(join(shots, `${base}-seeded.png`)))
  check('the small display spells 320×200 px of 320×200 pt', /\(320×200 px of 320×200 pt\)/.test(second.result), second.result)
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  resetDesktopDriverForTest()
}

finish('prove-computer-scale-mapping')
