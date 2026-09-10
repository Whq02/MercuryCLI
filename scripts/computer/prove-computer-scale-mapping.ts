#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, HOME, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'

const { pointOfPixel, pixelOfPoint } = await import('../../src/tools/ComputerTool/screenMap.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { pngDimensions } = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const { imageDimensionsFromHeader } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
const { clampToolResultImageBlocks } = await import('../../src/utils/imageResizer.ts')
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
  check('the corners stay on the same display after rounding', point(pointOfPixel(retina, 0, 0)) === point({ x: 0, y: 0 }) && point(pointOfPixel(retina, 2879, 1799)) === point({ x: 1439, y: 899 }))
  const retinaLeft = map({ originX: -1440, originY: -900 })
  check('the last pixel on a negative-origin retina display stays inside', point(pointOfPixel(retinaLeft, 2879, 1799)) === point({ x: -1, y: -1 }))
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

section('§2 the screen map uses the image after the real execution-boundary clamp')
for (const [model, noise] of [['claude-fable-5-1', false], ['kimi-k3', false], ['claude-fable-5-1', true]] as const) {
  const scene = join(scratch, `capture-${model}-${noise}.json`)
  writeFileSync(scene, JSON.stringify({ noise }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const context = toolContext({ model })
  const id = `toolu_scale_${model}_${noise}`
  const answer = await ComputerTool.call({ action: 'screenshot', label: 'scale' } as never, context, allowEverything, toolUseTurn(id, 'Computer', { action: 'screenshot', label: 'scale' }))
  const out = resultOf(answer)
  check(`${model} noise=${noise}: the screenshot succeeds`, out.outcome === 'succeeded', out.result)
  const spelled = /display \d+ \((\d+)×(\d+) px of 1440×900 pt\)/.exec(out.result)
  check('the result line spells both coordinate spaces', spelled !== null, out.result)
  const disk = out.imagePath && existsSync(out.imagePath) ? readFileSync(out.imagePath) : null
  const diskHeader = disk === null ? null : pngDimensions(disk)
  check('the disk artifact retains the full 2880×1800 capture', diskHeader?.width === 2880 && diskHeader.height === 1800, JSON.stringify(diskHeader))
  const inline = out.inlinePath && existsSync(out.inlinePath) ? readFileSync(out.inlinePath) : disk
  const inlineHeader = inline === null ? null : imageDimensionsFromHeader(inline)
  const screen = out.screen as unknown as ScreenMap
  check('the screen map matches the inlined PNG or JPEG header', inlineHeader !== null && screen.imageWidth === inlineHeader.width && screen.imageHeight === inlineHeader.height, `${JSON.stringify(screen)} / ${JSON.stringify(inlineHeader)}`)
  check('the result line matches that same header', spelled !== null && Number(spelled[1]) === screen.imageWidth && Number(spelled[2]) === screen.imageHeight)
  check('a model-specific inline copy was created below the original width', out.inlinePath !== undefined && inlineHeader !== null && inlineHeader.width < 2880)
  const block = ComputerTool.mapToolResultToToolResultBlockParam(answer.data as never, id) as { type: string; content: Array<{ type: string; source?: { data?: string } }> }
  await clampToolResultImageBlocks(block, { model })
  const emitted = block.content.find(part => part.type === 'image')?.source?.data
  const wireHeader = typeof emitted === 'string' ? imageDimensionsFromHeader(Buffer.from(emitted, 'base64')) : null
  check('the execution-boundary image still has exactly the mapped dimensions', wireHeader !== null && wireHeader.width === screen.imageWidth && wireHeader.height === screen.imageHeight, `${JSON.stringify(wireHeader)} / ${JSON.stringify(screen)}`)
  check('the execution boundary leaves the prepared image bytes unchanged', emitted === inline?.toString('base64'))
  const center = pointOfPixel(screen, screen.imageWidth / 2, screen.imageHeight / 2)
  check('the centre of the image the model sees is the display centre', point(center) === point({ x: 720, y: 450 }), point(center))
  check('the result line names the cursor and application', /cursor \(\d+, \d+\)/.test(out.result) && out.result.includes('frontmost TextEdit'), out.result)
  if (noise) {
    check('the noisy fixture crosses the actual image token budget', disk !== null && Math.ceil(disk.toString('base64').length / 8) > 25_000, String(disk?.length))
    check('the noisy capture produces a smaller budgeted payload', disk !== null && inline !== null && inline.length < disk.length, `${disk?.length} / ${inline?.length}`)
  }
}
delete process.env.MERCURY_DESKTOP_FAKE_SCENE
resetDesktopDriverForTest()

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
  const captures = after.filter(name => !name.endsWith('.inline'))
  check(`after ${before} seeded files and two captures at most ${DESKTOP_SHOTS_KEEP} screenshots remain`, captures.length <= DESKTOP_SHOTS_KEEP, `${captures.length} screenshots / ${after.length} files`)
  check('every inline copy stays paired with a retained original', after.every(name => !name.endsWith('.inline') || captures.includes(name.slice(0, -'.inline'.length))))
  check('the two newest captures survive the prune', first.imagePath !== undefined && second.imagePath !== undefined && existsSync(first.imagePath) && existsSync(second.imagePath))
  check('the oldest seeded file is gone', !existsSync(join(shots, `${base}-seeded.png`)))
  check('the small display spells 320×200 px of 320×200 pt', /\(320×200 px of 320×200 pt\)/.test(second.result), second.result)
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  resetDesktopDriverForTest()
}

finish('prove-computer-scale-mapping')
