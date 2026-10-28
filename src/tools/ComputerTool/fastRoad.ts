import type { DesktopApplication, DesktopBounds, DesktopCapture, DesktopDisplay, DesktopDriver, DesktopTree, DesktopTreeElement } from '../../services/desktop/driver.js'
import { getImageProcessor } from '../FileReadTool/imageProcessor.js'
import { sleep } from '../../utils/sleep.js'
import { boundsOfPixels, type ScreenMap } from './screenMap.js'

interface ElementTarget {
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
  if (matches.length !== 1) return { refusal: `${targetWords(target)}: ${matches.length} matches${matches.length > 1 ? ' (ambiguous)' : ''}${tree.truncated ? ' in a truncated tree' : ''} — read tree and use a unique role/name/text or screenshot pixels` }
  if (tree.truncated) return { refusal: `${targetWords(target)}: the tree is truncated, so uniqueness is unknown — raise depth/limit or use screenshot pixels` }
  const frame = matches[0]!.frame
  if (frame === null || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
    return { refusal: `${targetWords(target)} has no usable bounds — take a screenshot and use its pixels` }
  }
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
}

export function pageContentNote(tree?: DesktopTree): string {
  if (tree?.webContent === 'absent') return 'this application exposes no page content to the tree — use a screenshot; a missing page element is not a confirmed absence'
  if (tree?.webContent === 'pending') return 'web accessibility requested; page content is still starting — wait until the element appears with durationMs:5000, or take a screenshot'
  return ''
}

export interface DesktopObservation {
  app?: DesktopApplication
  tree?: DesktopTree
}

export async function readObservation(driver: DesktopDriver, signal: AbortSignal, verify = false, identity?: string): Promise<DesktopObservation> {
  const front = await driver.frontmostApplication()
  if (!front.ok || signal.aborted) return {}
  if (identity !== undefined && front.value.identity !== identity) return { app: front.value }
  const tree = await driver.accessibilityTree(front.value, { depth: verify ? 32 : 3, count: verify ? 2000 : 200, scope: 'window', observation: !verify }, signal)
  if (signal.aborted) return { app: front.value }
  const current = await driver.frontmostApplication()
  if (!current.ok || signal.aborted) return {}
  if (!sameWindow(front.value, current.value) || front.value.title !== current.value.title) return { app: current.value }
  return { app: current.value, ...(tree.ok ? { tree: tree.value } : {}) }
}

function browserAddress(app: DesktopApplication | undefined, tree: DesktopTree | undefined): string | null {
  if (!app || !/(?:chrome|chromium|firefox|safari|brave|vivaldi|msedge|microsoftedge|opera|orion|arc)(?:[.\s-]|$)/i.test(`${app.identity} ${app.name}`)) return null
  const address = tree?.elements.find(element => /^AX(?:TextField|ComboBox)$/.test(element.role) && /^(?:address(?: and search)?(?: bar)?|location|url|search or enter (?:website name|address))$/i.test(element.title ?? ''))?.value?.trim()
  if (!address || /\s/.test(address)) return null
  try {
    const url = new URL(address.includes('://') ? address : `https://${address}`)
    if (!['https:', 'http:'].includes(url.protocol) || (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('['))) return null
    return `${url.host}${url.pathname}`
  } catch { return null }
}

function windowTitle({ app, tree }: DesktopObservation): string | null {
  return tree?.elements.find(element => /^AXWindow(?:\s|$)/.test(element.role))?.title ?? app?.title ?? null
}

function focusedElement(tree?: DesktopTree): DesktopTreeElement | null {
  const focused = tree?.focused ?? tree?.elements.find(element => element.focused === true && !element.role.includes('Window'))
  return focused && !focused.role.includes('Window') ? focused : null
}

export function observationChanged(before: DesktopObservation, after: DesktopObservation): boolean {
  if (before.app && after.app && (before.app.identity !== after.app.identity || before.app.windowId !== after.app.windowId)) return true
  const beforeTitle = windowTitle(before)
  const afterTitle = windowTitle(after)
  if (beforeTitle !== null && afterTitle !== null && beforeTitle !== afterTitle) return true
  const focusKey = (tree?: DesktopTree): string | undefined => {
    const focused = focusedElement(tree)
    if (!tree || (tree.focused === undefined && !focused && tree.truncated)) return undefined
    return JSON.stringify(focused && [focused.role, focused.title, focused.frame])
  }
  const beforeFocus = focusKey(before.tree)
  const afterFocus = focusKey(after.tree)
  return beforeFocus !== undefined && afterFocus !== undefined && beforeFocus !== afterFocus
}

export async function settledObservation(driver: DesktopDriver, before: DesktopObservation, signal: AbortSignal, settleMs: number, verify = false): Promise<{ observation: DesktopObservation; changed: boolean }> {
  const deadline = Date.now() + settleMs
  const bounded = settleMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(settleMs))]) : signal
  let observation: DesktopObservation = {}
  for (;;) {
    const current = await readObservation(driver, bounded, verify, before.app?.identity)
    if (current.app) observation = current
    const changed = observationChanged(before, observation)
    if (changed || bounded.aborted || Date.now() >= deadline) return { observation, changed }
    try { await sleep(Math.min(50, Math.max(0, deadline - Date.now())), bounded) } catch (error) {
      if (!bounded.aborted) throw error
      return { observation, changed }
    }
  }
}

export function treeObservation({ app, tree }: DesktopObservation): string {
  const title = windowTitle({ app, tree })
  const dialog = tree?.elements.find(element => /\b(?:AXApplicationDialog|AXSheet)\b/.test(element.role))
  const focused = focusedElement(tree)
  const url = browserAddress(app, tree)
  return `now: window ${title ? JSON.stringify(title) : 'unknown'}${dialog ? ` · dialog ${dialog.title ? JSON.stringify(dialog.title) : 'unknown'}` : ''} · focus ${focused ? `${focused.role}${focused.title ? ` ${JSON.stringify(focused.title)}` : ''}` : 'unknown'}${url ? ` · url ${url}` : ''}`
}

export function verificationWords(before?: DesktopTree, after?: DesktopTree): string {
  const focused = after?.elements.find(element => element.focused === true && !element.role.includes('Window'))
  const focus = focused ? `focused ${focused.role}${focused.title ? ` ${JSON.stringify(focused.title)}` : ''}` : 'focus unknown'
  if (!before || !after || before.truncated || after.truncated) return `verification unknown: a complete tree was not available · ${focus} — take a screenshot`
  return `${JSON.stringify(before.elements) === JSON.stringify(after.elements) ? 'no observed change in the tree — take a screenshot to check visibility or use wait-until before another act' : 'tree changed; this is not confirmation of the task outcome — read find for the expected result'} · ${focus}`
}

async function observationPixels(capture: DesktopCapture, display: { width: number; height: number }, bounds: DesktopBounds): Promise<Buffer | null> {
  const sx = capture.width / display.width
  const sy = capture.height / display.height
  const left = Math.max(0, Math.floor((bounds.x - capture.originX - 16) * sx))
  const top = Math.max(0, Math.floor((bounds.y - capture.originY - 16) * sy))
  const right = Math.min(capture.width, Math.ceil((bounds.x + bounds.width - capture.originX + 16) * sx))
  const bottom = Math.min(capture.height, Math.ceil((bounds.y + bounds.height - capture.originY + 16) * sy))
  if (right <= left || bottom <= top) return null
  const sharp = await getImageProcessor()
  return sharp(capture.png).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
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

async function cropCapture(capture: DesktopCapture, display: { width: number; height: number }, bounds?: DesktopBounds): Promise<{ capture: DesktopCapture; points: { width: number; height: number } }> {
  if (bounds === undefined) return { capture, points: display }
  const scaleX = capture.width / display.width
  const scaleY = capture.height / display.height
  const left = Math.floor((bounds.x - capture.originX) * scaleX)
  const top = Math.floor((bounds.y - capture.originY) * scaleY)
  const right = Math.ceil((bounds.x + bounds.width - capture.originX) * scaleX)
  const bottom = Math.ceil((bounds.y + bounds.height - capture.originY) * scaleY)
  if (left < 0 || top < 0 || right > capture.width || bottom > capture.height) throw new Error('region is outside the current display — take a full screenshot first')
  const width = right - left
  const height = bottom - top
  const sharp = await getImageProcessor()
  const png = await sharp(capture.png).extract({ left, top, width, height }).png().toBuffer()
  return { capture: { ...capture, png, width, height, originX: capture.originX + left / scaleX, originY: capture.originY + top / scaleY }, points: { width: width / scaleX, height: height / scaleY } }
}

export function windowOnDisplay(bounds: DesktopBounds, display: DesktopDisplay): DesktopBounds | undefined {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined
  const x = Math.max(display.originX, bounds.x)
  const y = Math.max(display.originY, bounds.y)
  const right = Math.min(display.originX + display.width, bounds.x + bounds.width)
  const bottom = Math.min(display.originY + display.height, bounds.y + bounds.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
}

export async function settledCapture(driver: DesktopDriver, display: DesktopDisplay, signal: AbortSignal, settleMs: number, region?: CaptureRegion, map?: ScreenMap | null, observe?: DesktopBounds, window?: DesktopBounds): Promise<{ capture: DesktopCapture; points: { width: number; height: number } }> {
  if (region) {
    const refusal = regionRefusal(region, map ?? null)
    if (refusal || !map) throw new Error(refusal ?? 'region has no screenshot frame')
    if (map.displayId !== display.id) throw new Error('the display changed since the last screenshot — take a full screenshot first')
  }
  const wanted = region && map ? boundsOfPixels(map, region) : window
  let bounds: DesktopBounds | undefined
  if (wanted) {
    const left = Math.floor((wanted.x - display.originX) * display.scale)
    const top = Math.floor((wanted.y - display.originY) * display.scale)
    const right = Math.ceil((wanted.x + wanted.width - display.originX) * display.scale)
    const bottom = Math.ceil((wanted.y + wanted.height - display.originY) * display.scale)
    bounds = { x: display.originX + left / display.scale, y: display.originY + top / display.scale, width: (right - left) / display.scale, height: (bottom - top) / display.scale }
  }
  const deadline = Date.now() + settleMs
  let previous: Buffer | undefined
  for (;;) {
    if (signal.aborted) throw new Error('interrupted')
    const nativeRegion = bounds !== undefined && driver.captureRegion !== undefined
    const answer = nativeRegion ? await driver.captureRegion!(display.index, bounds!, signal) : await driver.capture(display.index, signal)
    if (!answer.ok) throw new Error(answer.error.note)
    if (signal.aborted) throw new Error('interrupted')
    const frame = nativeRegion ? { capture: answer.value, points: { width: answer.value.width / answer.value.scale, height: answer.value.height / answer.value.scale } } : await cropCapture(answer.value, display, bounds)
    if (signal.aborted) throw new Error('interrupted')
    if (settleMs === 0) return frame
    const local = observe && !region ? await observationPixels(frame.capture, frame.points, observe) : null
    const pixels = local ?? frame.capture.png
    if (previous?.equals(pixels) || Date.now() >= deadline) return frame
    previous = pixels
    await sleep(Math.min(50, Math.max(0, deadline - Date.now())), signal)
  }
}
