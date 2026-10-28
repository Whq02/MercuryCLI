import { createHash } from 'node:crypto'
import type { DesktopApplication, DesktopBounds, DesktopCapture, DesktopDisplay, DesktopPoint, DesktopTree, DesktopTreeElement } from '../../services/desktop/driver.js'
import type { ScreenMap } from '../../services/desktop/desktopSession.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'

export type { ScreenMap }

type PixelOutside = { outside: true; imageWidth: number; imageHeight: number }

export function isPixelOutside(value: DesktopPoint | PixelOutside): value is PixelOutside {
  return 'outside' in value && value.outside === true
}

export function pointOfPixel(map: ScreenMap, x: number, y: number): DesktopPoint | PixelOutside {
  const inside =
    Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < map.imageWidth && y < map.imageHeight
  if (!inside) return { outside: true, imageWidth: map.imageWidth, imageHeight: map.imageHeight }
  return {
    x: Math.min(map.originX + map.pointWidth - 1, Math.round(map.originX + (x * map.pointWidth) / map.imageWidth)),
    y: Math.min(map.originY + map.pointHeight - 1, Math.round(map.originY + (y * map.pointHeight) / map.imageHeight)),
  }
}

export function pixelOfPoint(map: ScreenMap, point: DesktopPoint): { x: number; y: number } {
  return {
    x: Math.round(((point.x - map.originX) * map.imageWidth) / map.pointWidth),
    y: Math.round(((point.y - map.originY) * map.imageHeight) / map.pointHeight),
  }
}

export function pixelOnScreen(map: ScreenMap, pixel: { x: number; y: number }): boolean {
  return pixel.x >= 0 && pixel.y >= 0 && pixel.x < map.imageWidth && pixel.y < map.imageHeight
}

export function boundsOfPixels(map: ScreenMap, region: { x: number; y: number; width: number; height: number }) {
  return {
    x: map.originX + region.x * map.pointWidth / map.imageWidth,
    y: map.originY + region.y * map.pointHeight / map.imageHeight,
    width: region.width * map.pointWidth / map.imageWidth,
    height: region.height * map.pointHeight / map.imageHeight,
  }
}

export function screenMapOfCapture(
  toolUseId: string,
  capture: Pick<DesktopCapture, 'display' | 'displayId' | 'originX' | 'originY' | 'capturedAt'>,
  display: Pick<DesktopDisplay, 'width' | 'height'>,
  image: { width: number; height: number },
): ScreenMap {
  return {
    toolUseId,
    display: capture.display,
    displayId: capture.displayId,
    originX: capture.originX,
    originY: capture.originY,
    pointWidth: display.width,
    pointHeight: display.height,
    imageWidth: image.width,
    imageHeight: image.height,
    capturedAt: capture.capturedAt,
  }
}

export function screenMapSizeWords(map: Pick<ScreenMap, 'imageWidth' | 'imageHeight' | 'pointWidth' | 'pointHeight'>): string {
  return `${map.imageWidth}×${map.imageHeight} px of ${map.pointWidth}×${map.pointHeight} pt`
}

export interface OutlineElement extends DesktopTreeElement {
  ref: number
  sourceIndices: number[]
}

export interface DesktopOutline extends DesktopTree {
  elements: OutlineElement[]
}

export function interactiveRole(role: string): boolean {
  return /^(AX)?(Button|Cell|CheckBox|ColorWell|ComboBox|DateField|DisclosureTriangle|DockItem|Incrementor|Link|MenuButton|MenuItem|OutlineRow|PopUpButton|RadioButton|Row|ScrollBar|SearchField|Slider|Splitter|Tab|TextArea|TextField|ToggleButton|TreeItem)(?:$| \()/i.test(role)
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim() !== ''
}

function visibleFrame(frame: DesktopBounds | null, bounds: DesktopBounds | null): boolean {
  if (frame === null) return true
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) return false
  return bounds === null || (frame.x < bounds.x + bounds.width && frame.x + frame.width > bounds.x && frame.y < bounds.y + bounds.height && frame.y + frame.height > bounds.y)
}

function textOf(element: DesktopTreeElement): string {
  return [element.title, element.value === element.title ? null : element.value].filter(value => value !== null).join(' ')
}

function mergedText(elements: DesktopTreeElement[]): DesktopTreeElement {
  const text = elements.map(textOf).join(' ').replace(/\s+/g, ' ').trim()
  const frames = elements.flatMap(element => element.frame ? [element.frame] : [])
  const left = Math.min(...frames.map(frame => frame.x))
  const top = Math.min(...frames.map(frame => frame.y))
  const right = Math.max(...frames.map(frame => frame.x + frame.width))
  const bottom = Math.max(...frames.map(frame => frame.y + frame.height))
  return { ...elements[0]!, title: text, value: null, frame: frames.length ? { x: left, y: top, width: right - left, height: bottom - top } : null }
}

export function outlineTree(tree: DesktopTree, bounds: DesktopBounds | null, options: { all?: boolean; root?: DesktopTreeElement; depth?: number; count?: number } = {}): DesktopOutline {
  const rows: OutlineElement[] = []
  const ancestors: Array<{ rawDepth: number; keptDepth: number; index: number; menu: boolean; value: string | null }> = []
  const sources = (options.root as OutlineElement | undefined)?.sourceIndices
  const start = sources?.[0] ?? (options.root ? tree.elements.indexOf(options.root) : 0)
  if (start < 0) return { ...tree, elements: [] }
  const rootDepth = options.root?.depth
  let previousParent = -2
  for (let index = start; index < tree.elements.length; index++) {
    const element = tree.elements[index]!
    if (rootDepth !== undefined && index > (sources?.at(-1) ?? start) && element.depth <= rootDepth) break
    while (ancestors.length && ancestors.at(-1)!.rawDepth >= element.depth) ancestors.pop()
    const parent = ancestors.at(-1)
    const menu = element.role === 'AXMenuBar' || parent?.menu === true
    const menuHidden = menu && (element.frame === null || element.frame.width <= 0 || element.frame.height <= 0)
    const visible = options.all || visibleFrame(element.frame, bounds)
    const duplicateText = !options.all && element.role === 'AXStaticText' && hasText(textOf(element)) && parent?.value === textOf(element)
    const keep = !menuHidden && visible && !duplicateText && (hasText(element.title) || hasText(element.value) || interactiveRole(element.role))
    const keptDepth = (parent?.keptDepth ?? -1) + (keep ? 1 : 0)
    const previous = rows.at(-1)
    const staticSibling = element.role === 'AXStaticText' && previous?.role === 'AXStaticText' && previousParent === (parent?.index ?? -1) && previous.sourceIndices.at(-1) === index - 1
    if (!menuHidden && visible && !duplicateText && staticSibling) {
      previous.sourceIndices.push(index)
      Object.assign(previous, mergedText(previous.sourceIndices.map(source => tree.elements[source]!)), { depth: previous.depth })
    } else if (keep) {
      rows.push({ ...element, depth: keptDepth, ref: rows.length + 1, sourceIndices: [index] })
      previousParent = parent?.index ?? -1
    }
    ancestors.push({ rawDepth: element.depth, keptDepth, index, menu, value: keep ? element.value : parent?.value ?? null })
  }
  const depth = options.depth ?? 12
  const count = options.count ?? 400
  const elements = rows.filter(row => row.depth <= depth).slice(0, count)
  const cut = elements.length !== rows.length
  return { ...tree, elements, truncated: tree.truncated || cut, reason: cut ? `the limit of ${count} elements or depth ${depth}` : tree.reason }
}

export function outlineRowWords(element: OutlineElement, map: ScreenMap | null = null, points = false): string {
  const parts = [`[${element.ref}]`, element.role]
  if (hasText(element.title)) parts.push(JSON.stringify(element.title))
  if (hasText(element.value) && element.value !== element.title) parts.push(JSON.stringify(element.value))
  if (points && element.frame && map) {
    const frame = element.frame
    const pixel = pixelOfPoint(map, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 })
    if (pixelOnScreen(map, pixel)) parts.push(`(${pixel.x},${pixel.y})px`)
  }
  return `${'  '.repeat(element.depth)}${parts.join(' ')}`
}

function elementPaths(tree: DesktopTree): string[] {
  const ancestors: Array<{ depth: number; key: string }> = []
  return tree.elements.map(element => {
    while (ancestors.length && ancestors.at(-1)!.depth >= element.depth) ancestors.pop()
    const path = createHash('sha256').update(JSON.stringify([ancestors.at(-1)?.key, element.role, element.title, element.frame])).digest('hex')
    ancestors.push({ depth: element.depth, key: path })
    return path
  })
}

const treeRefs = new OwnerScopedStore<{ next: number; window: string; refs: Map<number, string[]> }>({
  name: 'computer-tree-refs',
  create: () => ({ next: 1, window: '', refs: new Map() }),
  dispose: state => { state.refs.clear() },
})
registerOwnerScopedStore(treeRefs)

function windowKey(app: DesktopApplication): string {
  return JSON.stringify([app.identity, app.pid, app.windowId, app.bounds])
}

export function rememberTreeRefs(owner: OwnerKey, app: DesktopApplication, tree: DesktopTree, outline: DesktopOutline): void {
  const state = treeRefs.get(owner)
  state.window = windowKey(app)
  state.refs.clear()
  const paths = elementPaths(tree)
  for (const element of outline.elements) {
    element.ref = state.next++
    state.refs.set(element.ref, element.sourceIndices.map(index => paths[index]!))
  }
}

export function resolveTreeRef(owner: OwnerKey, app: DesktopApplication, tree: DesktopTree, ref: number): DesktopTreeElement[] {
  const state = treeRefs.peek(owner)
  const keys = state?.window === windowKey(app) ? state.refs.get(ref) : undefined
  if (!keys?.length) return []
  const paths = elementPaths(tree)
  const matches = keys.map(key => paths.flatMap((path, index) => path === key ? [index] : []))
  if (keys.length === 1) return matches[0]!.map(index => tree.elements[index]!)
  if (matches.some(indices => indices.length !== 1)) return []
  const sourceIndices = matches.map(indices => indices[0]!)
  if (sourceIndices.some((index, offset) => offset > 0 && index !== sourceIndices[offset - 1]! + 1)) return []
  return [{ ...mergedText(sourceIndices.map(index => tree.elements[index]!)), sourceIndices, ref } as OutlineElement]
}
