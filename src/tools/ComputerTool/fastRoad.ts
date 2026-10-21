import type { DesktopApplication, DesktopBounds, DesktopCapture, DesktopDriver, DesktopTree, DesktopTreeElement } from '../../services/desktop/driver.js'
import { getImageProcessor } from '../FileReadTool/imageProcessor.js'
import { sleep } from '../../utils/sleep.js'
import type { ScreenMap } from './screenMap.js'

export interface ElementTarget {
  role?: string
  name?: string
  text?: string
}

export type CaptureRegion = DesktopBounds

const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

export function targetWords(target: ElementTarget): string {
  return [target.role, target.name === undefined ? undefined : JSON.stringify(target.name), target.text === undefined ? undefined : `text=${JSON.stringify(target.text)}`].filter(Boolean).join(' ')
}

export function targetMatches(tree: DesktopTree, target: ElementTarget): DesktopTreeElement[] {
  return tree.elements.filter(element =>
    (target.role === undefined || normalized(element.role) === normalized(target.role)) &&
    (target.name === undefined || normalized(element.title ?? '') === normalized(target.name)) &&
    (target.text === undefined || normalized(`${element.title ?? ''} ${element.value ?? ''}`).includes(normalized(target.text))),
  )
}

export function targetPoint(tree: DesktopTree, target: ElementTarget): { x: number; y: number } | { refusal: string } {
  const matches = targetMatches(tree, target)
  if (matches.length !== 1) return { refusal: `${targetWords(target)}: ${matches.length} matches${tree.truncated ? ' in a truncated tree' : ''} — read tree and use a unique role/name/text or screenshot pixels` }
  if (tree.truncated) return { refusal: `${targetWords(target)}: the tree is truncated, so uniqueness is unknown — raise depth/limit or use screenshot pixels` }
  const frame = matches[0]!.frame
  if (frame === null || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
    return { refusal: `${targetWords(target)} has no usable bounds — take a screenshot and use its pixels` }
  }
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
}

export function sameWindow(a: DesktopApplication, b: DesktopApplication): boolean {
  return a.identity === b.identity && a.windowId === b.windowId && JSON.stringify(a.bounds) === JSON.stringify(b.bounds)
}

export function regionRefusal(region: CaptureRegion, map: ScreenMap | null): string | null {
  if (map === null) return 'region requires a screenshot first — its rectangle uses pixels of the last screenshot'
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > map.imageWidth || region.y + region.height > map.imageHeight) {
    return 'region is outside the last screenshot — use a positive rectangle inside its pixels'
  }
  return null
}

export async function cropCapture(capture: DesktopCapture, display: { width: number; height: number }, region?: CaptureRegion, map?: ScreenMap | null): Promise<{ capture: DesktopCapture; points: { width: number; height: number } }> {
  if (region === undefined) return { capture, points: display }
  const refusal = regionRefusal(region, map ?? null)
  if (refusal !== null || !map) throw new Error(refusal ?? 'region has no screenshot frame')
  if (capture.displayId !== map.displayId) throw new Error('the display changed since the last screenshot — take a full screenshot first')
  const scaleX = capture.width / display.width
  const scaleY = capture.height / display.height
  const left = Math.floor((map.originX - capture.originX + region.x * map.pointWidth / map.imageWidth) * scaleX)
  const top = Math.floor((map.originY - capture.originY + region.y * map.pointHeight / map.imageHeight) * scaleY)
  const right = Math.ceil((map.originX - capture.originX + (region.x + region.width) * map.pointWidth / map.imageWidth) * scaleX)
  const bottom = Math.ceil((map.originY - capture.originY + (region.y + region.height) * map.pointHeight / map.imageHeight) * scaleY)
  if (left < 0 || top < 0 || right > capture.width || bottom > capture.height) throw new Error('region is outside the current display — take a full screenshot first')
  const width = right - left
  const height = bottom - top
  const sharp = await getImageProcessor()
  const png = await sharp(capture.png).extract({ left, top, width, height }).png().toBuffer()
  return { capture: { ...capture, png, width, height, originX: capture.originX + left / scaleX, originY: capture.originY + top / scaleY }, points: { width: width / scaleX, height: height / scaleY } }
}

export async function settledCapture(driver: DesktopDriver, display: { index: number; width: number; height: number }, signal: AbortSignal, settleMs: number, region?: CaptureRegion, map?: ScreenMap | null): Promise<{ capture: DesktopCapture; points: { width: number; height: number }; settled: string }> {
  const deadline = Date.now() + settleMs
  let previous: Buffer | undefined
  for (;;) {
    if (signal.aborted) throw new Error('interrupted')
    const answer = await driver.capture(display.index, signal)
    if (!answer.ok) throw new Error(answer.error.note)
    if (signal.aborted) throw new Error('interrupted')
    const frame = await cropCapture(answer.value, display, region, map)
    if (signal.aborted) throw new Error('interrupted')
    if (settleMs === 0) return { ...frame, settled: '' }
    if (previous?.equals(frame.capture.png)) return { ...frame, settled: 'screen stable' }
    if (Date.now() >= deadline) return { ...frame, settled: 'settle cap reached' }
    previous = frame.capture.png
    await sleep(Math.min(50, Math.max(0, deadline - Date.now())), signal)
  }
}
