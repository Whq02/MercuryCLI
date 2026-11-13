import indentString from 'indent-string'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { applyTextStyles } from './colorize.js'
import { expandTabsWithColumn } from './tabstops.js'
import type { DOMElement as FrameNode } from './dom.js'
import getMaxWidth from './get-max-width.js'
import type { Rectangle } from './layout/geometry.js'
import { LayoutDisplay, LayoutEdge, type LayoutNode } from './layout/node.js'
import { type CachedLayout, consumeChildRemoved, hasNestedScroll, hasReachingChild, nodeCache, pendingClears, setChildReach, setHasNestedScroll } from './node-cache.js'
import type ComposeBuffer from './compose-buffer.js'
import renderBorder from './render-border.js'
import type { Screen } from './cell-grid.js'
import squashTextNodes, { type StyledSegment, squashTextNodesToSegments } from './squash-text-nodes.js'
import type { Color } from './styles.js'
import { isXtermJs } from './session/capabilities.js'
import { widestLine } from './widest-line.js'
import wrapText, { truncateParts } from './wrap-text.js'


export type ScrollHint = { delta: number; top: number; bottom: number }
export type ScrollTranslation = { delta: number; viewportTop: number; viewportBottom: number }
export type AbsoluteEntry = { node: FrameNode; rect: CachedLayout }

const SHIFT_LOG_CAP = 48
const shiftForensicsOn = !!process.env.INK_COMPOSED_TEE

export class ComposeSignals {
  layoutShifted: boolean = false
  private shiftMinRow: number | null = null
  private shiftRowUnknown = false
  shiftReason: string | null = null
  shiftLog: string[] = []
  scrollHint: ScrollHint | null = null
  scrollDrainNode: FrameNode | null = null
  scrollTranslation: ScrollTranslation | null = null
  readonly absoluteRectsCur: Rectangle[] = []
  readonly absoluteEntriesCur: AbsoluteEntry[] = []
  readonly reachRectsCur: Rectangle[] = []

  markLayoutShift(reason: () => string, divergentRow?: number): void {
    if (shiftForensicsOn && this.shiftLog.length < SHIFT_LOG_CAP) {
      const words = reason()
      if (!this.layoutShifted) this.shiftReason = words
      this.shiftLog.push(words)
    }
    if (divergentRow === undefined || !Number.isFinite(divergentRow)) this.shiftRowUnknown = true
    else this.shiftMinRow = this.shiftMinRow === null ? divergentRow : Math.min(this.shiftMinRow, divergentRow)
    this.layoutShifted = true
  }

  shiftBandTop(): number | null {
    if (!this.layoutShifted || this.shiftRowUnknown || this.shiftMinRow === null) return null
    return Math.max(0, Math.floor(this.shiftMinRow))
  }

  consumeScrollTranslation(): ScrollTranslation | null {
    const translation = this.scrollTranslation
    this.scrollTranslation = null
    return translation
  }
}

export function invalidOverlayRects(root: FrameNode, entries: readonly AbsoluteEntry[]): Rectangle[] {
  if (entries.length === 0) return []
  const out: Rectangle[] = []
  const rootLayout = root.layoutNode
  if (!rootLayout || rootLayout.getDisplay() === LayoutDisplay.None) {
    for (const { rect } of entries) out.push(floorRect(rect.reach ?? rect))
    return out
  }
  for (const { node, rect } of entries) {
    const chain: FrameNode[] = []
    let cur: FrameNode | undefined = node
    while (cur && cur !== root) {
      chain.push(cur)
      cur = cur.parentNode
    }
    if (cur !== root) {
      out.push(floorRect(rect.reach ?? rect))
      continue
    }
    let x = rootLayout.getComputedLeft()
    let y = rootLayout.getComputedTop()
    let hiddenOrScrolled = false
    for (let i = chain.length - 1; i >= 0; i--) {
      const el = chain[i]!
      const layout = el.layoutNode
      if (!layout || layout.getDisplay() === LayoutDisplay.None) {
        hiddenOrScrolled = true
        break
      }
      const parentStyle = el.parentNode?.style
      if (parentStyle?.overflowY === 'scroll' || parentStyle?.overflow === 'scroll') {
        hiddenOrScrolled = true
        break
      }
      x += layout.getComputedLeft()
      const rawY = y + layout.getComputedTop()
      y = rawY < 0 && el.style.position === 'absolute' ? 0 : rawY
    }
    if (hiddenOrScrolled) {
      out.push(floorRect(rect.reach ?? rect))
      continue
    }
    const width = node.layoutNode!.getComputedWidth()
    const height = node.layoutNode!.getComputedHeight()
    if (x !== rect.x || y !== rect.y || width !== rect.width || height !== rect.height) {
      out.push(floorRect(rect.reach ?? rect))
      continue
    }
    if (
      node.dirty &&
      ((!node.style.opaque && node.style.backgroundColor === undefined && node.style.fillRowBg === undefined) ||
        rect.reach !== undefined)
    ) {
      out.push(floorRect(rect.reach ?? rect))
    }
  }
  return out
}

function rectsOverlap(x: number, y: number, width: number, height: number, rects: readonly Rectangle[]): boolean {
  if (rects.length === 0) return false
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.ceil(x + width)
  const bottom = Math.ceil(y + height)
  for (const r of rects) {
    if (left < r.x + r.width && right > r.x && top < r.y + r.height && bottom > r.y) return true
  }
  return false
}

export function expandDamageForAbsoluteRects(screen: { width: number; height: number; damage: Rectangle | undefined }, prevRects: readonly Rectangle[], curRects: readonly Rectangle[]): void {
  for (const rect of [...prevRects, ...curRects]) {
    const left = Math.max(0, Math.floor(rect.x))
    const top = Math.max(0, Math.floor(rect.y))
    const right = Math.min(screen.width, Math.ceil(rect.x + rect.width))
    const bottom = Math.min(screen.height, Math.ceil(rect.y + rect.height))
    if (right <= left || bottom <= top) continue
    const box = screen.damage
    if (box === undefined) {
      screen.damage = { x: left, y: top, width: right - left, height: bottom - top }
    } else {
      const boxRight = Math.max(box.x + box.width, right)
      const boxBottom = Math.max(box.y + box.height, bottom)
      if (left < box.x) box.x = left
      if (top < box.y) box.y = top
      box.width = boxRight - box.x
      box.height = boxBottom - box.y
    }
  }
}

function hostIsXtermJs(): boolean {
  const vscodeTerminal = process.env.TERM_PROGRAM === 'vscode'
  return vscodeTerminal || isXtermJs()
}

const SCROLL_FLOOR_PER_FRAME = 4
const SCROLL_SNAP_BELOW = 5
const SCROLL_BACKLOG_HIGH = 12
const SCROLL_STEP_MEDIUM = 2
const SCROLL_STEP_FAST = 3
const SCROLL_BACKLOG_CAP = 30

function drainAdaptive(node: FrameNode, pending: number, innerHeight: number): number {
  const direction = pending > 0 ? 1 : -1
  const backlog = Math.abs(pending)
  const snap = Math.max(0, backlog - SCROLL_BACKLOG_CAP)
  const window = backlog - snap
  const step = window <= SCROLL_SNAP_BELOW ? window : window < SCROLL_BACKLOG_HIGH ? SCROLL_STEP_MEDIUM : SCROLL_STEP_FAST
  const rowCap = Math.max(1, innerHeight - 1)
  const travel = Math.min(snap + step, rowCap)
  const leftover = backlog - travel
  ;(node.scroll ??= {}).pendingScrollDelta = leftover > 0 ? direction * leftover : undefined
  return direction * travel
}

function drainProportional(node: FrameNode, pending: number, innerHeight: number): number {
  const backlog = Math.abs(pending)
  const rowCap = Math.max(1, innerHeight - 1)
  const step = Math.min(rowCap, Math.max(SCROLL_FLOOR_PER_FRAME, (backlog * 3) >> 2))
  const drained = backlog <= step
  const travel = drained ? pending : pending > 0 ? step : -step
  ;(node.scroll ??= {}).pendingScrollDelta = drained ? undefined : pending - travel
  return travel
}

const OSC_OPEN = '\u001B]'
const BELL = '\u0007'
const WHITESPACE = /\s/

const linkWrapped = (text: string, url: string): string => `${OSC_OPEN}8;;${url}${BELL}${text}${OSC_OPEN}8;;${BELL}`

const isWhitespaceAt = (text: string, at: number): boolean => at < text.length && WHITESPACE.test(text[at]!)

function styleRun(segments: StyledSegment[], owner: number, runText: string): string {
  const segment = segments[owner]
  if (segment === undefined) return runText
  const styled = applyTextStyles(runText, segment.styles)
  return segment.hyperlink ? linkWrapped(styled, segment.hyperlink) : styled
}

function buildCharToSegmentMap(runs: StyledSegment[]): number[] {
  const owners: number[] = []
  runs.forEach((segment, index) => {
    for (let unit = 0; unit < segment.text.length; unit++) owners.push(index)
  })
  return owners
}

const wrapperInputForm = (text: string): string => text.normalize('NFC').replace(/\r\n/g, '\n')

function wrapperNormalForm(segments: StyledSegment[], plainText: string): { plain: string; charToSegment: number[] } {
  const plain = wrapperInputForm(plainText)
  if (plain === plainText) return { plain, charToSegment: buildCharToSegmentMap(segments) }
  const charToSegment: number[] = []
  let through = ''
  segments.forEach((segment, index) => {
    through += segment.text
    const upto = wrapperInputForm(through).length
    while (charToSegment.length < upto) charToSegment.push(index)
  })
  return { plain, charToSegment }
}

function applyStylesToWrappedText(wrappedPlain: string, segments: StyledSegment[], charToSegment: number[], originalPlain: string, trimEnabled: boolean = false, softWrap?: readonly boolean[]): string {
  const outputLines = wrappedPlain.split('\n')
  const styledLines: string[] = []
  let sourceAt = 0
  outputLines.forEach((outputLine, lineIndex) => {
    if (trimEnabled && outputLine.length > 0) {
      const lineOpensWithSpace = WHITESPACE.test(outputLine[0]!)
      if (isWhitespaceAt(originalPlain, sourceAt) && !lineOpensWithSpace) {
        while (isWhitespaceAt(originalPlain, sourceAt)) sourceAt++
      }
    } else if (softWrap?.[lineIndex] === true && !outputLine.startsWith(' ')) {
      while (sourceAt < originalPlain.length && originalPlain[sourceAt] === ' ') sourceAt++
    }
    let styledOutput = ''
    let runFrom = 0
    let runOwner = charToSegment[sourceAt] ?? 0
    for (let at = 0; at < outputLine.length; at++) {
      const owner = charToSegment[sourceAt] ?? runOwner
      if (owner !== runOwner) {
        styledOutput += styleRun(segments, runOwner, outputLine.slice(runFrom, at))
        runFrom = at
        runOwner = owner
      }
      sourceAt++
    }
    styledOutput += styleRun(segments, runOwner, outputLine.slice(runFrom))
    styledLines.push(styledOutput)
    if (sourceAt < originalPlain.length && originalPlain[sourceAt] === '\n') sourceAt++
    if (trimEnabled && lineIndex < outputLines.length - 1) {
      const nextLine = outputLines[lineIndex + 1]!
      const nextFirst = nextLine.length > 0 ? nextLine[0] : null
      while (isWhitespaceAt(originalPlain, sourceAt)) {
        if (nextFirst !== null && originalPlain[sourceAt] === nextFirst) break
        sourceAt++
      }
    }
  })
  return styledLines.join('\n')
}

function styleSourceRange(plainText: string, segments: StyledSegment[], charToSegment: number[], from: number, to: number): string {
  let rangeStyled = ''
  let runFrom = from
  let runOwner = charToSegment[from] ?? 0
  const flush = (end: number): void => {
    if (end > runFrom) rangeStyled += styleRun(segments, runOwner, plainText.slice(runFrom, end))
  }
  for (let at = from; at < to; at++) {
    const owner = charToSegment[at] ?? runOwner
    if (owner !== runOwner) {
      flush(at)
      runFrom = at
      runOwner = owner
    }
  }
  flush(to)
  return rangeStyled
}

function styleTruncatedLines(plainText: string, segments: StyledSegment[], charToSegment: number[], maxWidth: number, textWrap: string): string {
  const styledLines: string[] = []
  let base = 0
  for (const line of plainText.split('\n')) {
    const end = base + line.length
    const parts = truncateParts(line, maxWidth, textWrap)
    if (parts === null) {
      styledLines.push(styleSourceRange(plainText, segments, charToSegment, base, end))
    } else {
      const leadEnd = base + parts.lead.length
      const trailStart = end - parts.trail.length
      const cutAt = Math.max(base, Math.min(leadEnd, end - 1))
      const cutOwner = segments[charToSegment[cutAt] ?? 0]
      const lead = styleSourceRange(plainText, segments, charToSegment, base, leadEnd)
      const ellipsis = parts.ellipsis ? (cutOwner ? applyTextStyles('…', cutOwner.styles) : '…') : ''
      styledLines.push(lead + ellipsis + styleSourceRange(plainText, segments, charToSegment, trailStart, end))
    }
    base = end + 1
  }
  return styledLines.join('\n')
}

function wrapWithSoftWrap(plainText: string, maxWidth: number, textWrap: Parameters<typeof wrapText>[2]): { wrapped: string; softWrap: boolean[] | undefined } {
  const truncates = textWrap !== 'wrap' && textWrap !== 'wrap-trim'
  if (truncates) {
    const cut = plainText.includes('\n') ? plainText.split('\n').map(line => wrapText(line, maxWidth, textWrap)).join('\n') : wrapText(plainText, maxWidth, textWrap)
    return { wrapped: cut, softWrap: undefined }
  }
  const pieces: string[] = []
  const continuations: boolean[] = []
  for (const sourceLine of plainText.split('\n')) {
    wrapText(sourceLine, maxWidth, textWrap).split('\n').forEach((piece, index) => {
      pieces.push(piece)
      continuations.push(index > 0)
    })
  }
  return { wrapped: pieces.join('\n'), softWrap: continuations }
}

const firstChildOffset = (node: FrameNode): { left: number; top: number } | null => {
  const layout = node.childNodes[0]?.layoutNode
  return layout ? { left: layout.getComputedLeft(), top: layout.getComputedTop() } : null
}

const alignSoftWrapFlags = (flags: boolean[] | undefined, rowsAbove: number): void => {
  if (flags && rowsAbove > 0) flags.unshift(...new Array<boolean>(rowsAbove).fill(false))
}

const belowRows = (text: string, rowsAbove: number): string => (rowsAbove > 0 ? '\n'.repeat(rowsAbove) + text : text)

function applyPaddingToText(node: FrameNode, text: string, softWrap?: boolean[]): string {
  const offset = firstChildOffset(node)
  if (!offset) return text
  alignSoftWrapFlags(softWrap, offset.top)
  return belowRows(indentString(text, offset.left), offset.top)
}

type RowGround = (row: number) => Color | undefined

type Walk = { buffer: ComposeBuffer; signals: ComposeSignals; prevAbsoluteRects: readonly Rectangle[]; invalidRects: readonly Rectangle[]; regionScrollUsable: boolean; scrollDepth: number; sawInnerScroll: boolean }

type Own = { left: number; top: number; right: number; bottom: number }

type Placement = { offsetX?: number; offsetY?: number; prevScreen: Screen | undefined; skipSelfBlit?: boolean; inheritedBackgroundColor?: Color; inheritedRowBg?: RowGround; own?: Own }

type ComposeOptions = { offsetX?: number; offsetY?: number; prevScreen: Screen | undefined; signals?: ComposeSignals; prevAbsoluteRects?: readonly Rectangle[]; invalidRects?: readonly Rectangle[]; regionScrollUsable?: boolean }

const floorRect = (rect: Rectangle): Rectangle => ({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) })

const clipping = (mode: string | undefined): boolean => mode === 'hidden' || mode === 'scroll'

export default function composeTree(root: FrameNode, buffer: ComposeBuffer, opts: ComposeOptions): ComposeSignals {
  const walk: Walk = { buffer, signals: opts.signals ?? new ComposeSignals(), prevAbsoluteRects: opts.prevAbsoluteRects ?? [], invalidRects: opts.invalidRects ?? [], regionScrollUsable: opts.regionScrollUsable === true, scrollDepth: 0, sawInnerScroll: false }
  composeNode(root, walk, { offsetX: opts.offsetX, offsetY: opts.offsetY, prevScreen: opts.prevScreen })
  return walk.signals
}

function composeNode(node: FrameNode, walk: Walk, placement: Placement): boolean {
  const { layoutNode } = node
  if (!layoutNode) return false
  if (layoutNode.getDisplay() === LayoutDisplay.None) {
    return clearHidden(node, walk)
  }
  return placeNode(node, layoutNode, walk, placement)
}

function clearHidden(hidden: FrameNode, walk: Walk): boolean {
  const cached = nodeCache.get(hidden)
  if (cached !== undefined) {
    walk.buffer.clear(floorRect(cached.reach ?? cached))
    walk.signals.markLayoutShift(() => `display-none-clear:${hidden.nodeName}`, Math.floor(cached.y))
  }
  clearHiddenSubtree(hidden)
  return cached !== undefined
}

function clearHiddenSubtree(root: FrameNode): void {
  const pending: FrameNode[] = [root]
  while (pending.length > 0) {
    const elem = pending.pop()!
    nodeCache.delete(elem)
    if (elem.parentNode) setChildReach(elem.parentNode, elem, false)
    elem.dirty = false
    for (const child of elem.childNodes) {
      if (child.nodeName !== '#text') pending.push(child as FrameNode)
    }
  }
}

function placeNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement): boolean {
  const x = (placement.offsetX ?? 0) + layoutNode.getComputedLeft()
  const floating = node.style.position === 'absolute'
  const unclampedY = (placement.offsetY ?? 0) + layoutNode.getComputedTop()
  const y = unclampedY < 0 && floating ? 0 : unclampedY
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()
  const held = nodeCache.get(node)
  const rectHeld = held !== undefined && held.x === x && held.y === y && held.width === width && held.height === height
  const overlapsInvalid = rectsOverlap(x, y, width, height, walk.invalidRects)
  const reusable = !node.dirty && !overlapsInvalid && !placement.skipSelfBlit && node.scroll?.pendingScrollDelta === undefined && rectHeld && placement.prevScreen !== undefined && held!.reach === undefined && (floating || insideOwn(placement.own, x, y, width, height))
  if (reusable) {
    reuseNode(node, held!, walk, placement.prevScreen!, floating, x, y, width, height)
    return false
  }
  repaintNode(node, layoutNode, walk, placement, held, rectHeld, floating, x, y, width, height)
  return true
}

function reuseNode(node: FrameNode, cached: CachedLayout, walk: Walk, prevScreen: Screen, floating: boolean, x: number, y: number, width: number, height: number): void {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const columns = Math.floor(width)
  const rows = Math.floor(height)
  walk.buffer.blit(prevScreen, left, top, columns, rows)
  if (floating) {
    walk.signals.absoluteRectsCur.push(cached)
    walk.signals.absoluteEntriesCur.push({ node, rect: cached })
  }
  blitEscapingAbsoluteDescendants(node, walk, prevScreen, left, top, columns, rows)
}

function movedForensics(node: FrameNode, cached: CachedLayout, x: number, y: number, width: number, height: number): string {
  const style = node.style as Record<string, unknown>
  const flexFacts = ` w=${JSON.stringify(style['width'])},mw=${JSON.stringify(style['minWidth'])},fg=${JSON.stringify(style['flexGrow'])},fs=${JSON.stringify(style['flexShrink'])},fb=${JSON.stringify(style['flexBasis'])},as=${JSON.stringify(style['alignSelf'])}`
  let words = ''
  if (node.nodeName === 'ink-text') {
    try {
      words = ` "${squashTextNodes(node).replace(/\n/g, '\\n').slice(0, 28)}"`
    } catch {}
  }
  const owners = node.debugOwnerChain ? ` [${node.debugOwnerChain.slice(0, 5).join('<')}]` : ''
  return `moved:${node.nodeName}@${Math.floor(x)},${Math.floor(y)} ${cached.x},${cached.y},${cached.width}x${cached.height}→${x},${y},${width}x${height}${flexFacts}${words}${owners}`
}

const firstDivergentRow = (cached: CachedLayout, y: number, height: number): number =>
  cached.y !== y ? Math.floor(Math.min(cached.y, y)) : cached.height !== height ? Math.floor(y + Math.min(cached.height, height)) : Math.floor(y)

function repaintNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement, cached: CachedLayout | undefined, rectHeld: boolean, floating: boolean, x: number, y: number, width: number, height: number): void {
  const { buffer, signals } = walk
  const moved = cached !== undefined && !rectHeld
  if (moved) signals.markLayoutShift(() => movedForensics(node, cached, x, y, width, height), firstDivergentRow(cached, y, height))
  if (cached && (node.dirty || moved)) buffer.clear(floorRect(cached.reach ?? cached), floating)
  const vacated = vacatedRects(node)
  const hasRemovedChild = vacated !== undefined
  if (vacated !== undefined) {
    signals.markLayoutShift(() => `removed-child:${node.nodeName}`, vacated.length > 0 ? Math.min(...vacated.map(rect => Math.floor(rect.y))) : undefined)
    for (const rect of vacated) buffer.clear(floorRect(rect))
  }
  const placed: CachedLayout = { x, y, width, height }
  if (height === 0 && siblingSharesY(node, layoutNode)) {
    if (node.parentNode) setChildReach(node.parentNode, node, false)
    nodeCache.set(node, placed)
    forgetSubtree(node)
  } else {
    const painted = paintNode(node, layoutNode, walk, placement, x, y, width, height, hasRemovedChild)
    const reach = reachBeyond(node, x, y, width, height, painted)
    if (node.parentNode) setChildReach(node.parentNode, node, reach !== undefined)
    if (reach !== undefined) {
      placed.reach = reach
      if (!floating) signals.reachRectsCur.push(reach)
    }
    nodeCache.set(node, placed)
    if (floating) {
      signals.absoluteRectsCur.push(placed)
      signals.absoluteEntriesCur.push({ node, rect: placed })
    }
  }
  settle(node)
}

const insideOwn = (own: Own | undefined, x: number, y: number, width: number, height: number): boolean =>
  own === undefined || (x >= own.left && y >= own.top && x + width <= own.right && y + height <= own.bottom)

function ownWithin(own: Own | undefined, clipsAcross: boolean, clipsDown: boolean, x: number, y: number, width: number, height: number): Own {
  const outerLeft = own?.left ?? -Infinity
  const outerTop = own?.top ?? -Infinity
  const outerRight = own?.right ?? Infinity
  const outerBottom = own?.bottom ?? Infinity
  const heldAcross = x >= outerLeft && x + width <= outerRight
  const heldDown = y >= outerTop && y + height <= outerBottom
  return {
    left: clipsAcross ? (heldAcross ? -Infinity : Infinity) : Math.max(outerLeft, x),
    right: clipsAcross ? (heldAcross ? Infinity : -Infinity) : Math.min(outerRight, x + width),
    top: clipsDown ? (heldDown ? -Infinity : Infinity) : Math.max(outerTop, y),
    bottom: clipsDown ? (heldDown ? Infinity : -Infinity) : Math.min(outerBottom, y + height),
  }
}

type PaintedExtent = { width: number; height: number }

function reachBeyond(node: FrameNode, x: number, y: number, width: number, height: number, leafPainted?: PaintedExtent): Rectangle | undefined {
  if (node.nodeName !== 'ink-box') {
    if (leafPainted === undefined) return undefined
    const right = Math.max(x + width, x + leafPainted.width)
    const bottom = Math.max(y + height, y + leafPainted.height)
    return right > x + width || bottom > y + height ? { x, y, width: right - x, height: bottom - y } : undefined
  }
  const clipsAcross = clipping(node.style.overflowX ?? node.style.overflow)
  const clipsDown = clipping(node.style.overflowY ?? node.style.overflow)
  if (clipsAcross && clipsDown) return undefined
  let left = x
  let top = y
  let right = x + width
  let bottom = y + height
  for (const child of node.childNodes as FrameNode[]) {
    if (child.style.position === 'absolute') continue
    const held = nodeCache.get(child)
    if (held === undefined) continue
    const painted = held.reach ?? held
    if (!clipsAcross) {
      left = Math.min(left, painted.x)
      right = Math.max(right, painted.x + painted.width)
    }
    if (!clipsDown) {
      top = Math.min(top, painted.y)
      bottom = Math.max(bottom, painted.y + painted.height)
    }
  }
  return left < x || top < y || right > x + width || bottom > y + height ? { x: left, y: top, width: right - left, height: bottom - top } : undefined
}

const reachMoves = (child: FrameNode): boolean => child.dirty && child.style.position !== 'absolute' && nodeCache.get(child)?.reach !== undefined

function vacatedRects(parent: FrameNode): readonly Rectangle[] | undefined {
  const rects = pendingClears.get(parent)
  if (rects !== undefined) pendingClears.delete(parent)
  return rects
}

const settle = (painted: FrameNode): void => {
  painted.dirty = false
}

function paintNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement, x: number, y: number, width: number, height: number, hasRemovedChild: boolean): PaintedExtent | undefined {
  const kind = node.nodeName
  if (kind === 'ink-raw-ansi') {
    const rawText = node.attributes['rawText'] as string
    if (!rawText) return undefined
    walk.buffer.write(x, y, rawText)
    let rows = 1
    for (let i = 0; i < rawText.length; i++) {
      if (rawText.charCodeAt(i) === 10) rows++
    }
    const rawW = Number(node.attributes['rawWidth'] ?? 0)
    return { width: rawW > width ? rawW : widestLine(rawText), height: rows }
  } else if (kind === 'ink-text') {
    return composeText(node, walk, x, y, layoutNode, placement.inheritedBackgroundColor, placement.inheritedRowBg)
  } else if (kind === 'ink-box') {
    composeBox(node, walk, placement, x, y, width, height, layoutNode, hasRemovedChild)
  } else if (kind === 'ink-root') {
    composeChildren(node, walk, x, y, hasRemovedChild, placement.prevScreen, placement.inheritedBackgroundColor, placement.inheritedRowBg, undefined)
  }
  return undefined
}

const rowGrounded = (line: string, bg: Color | undefined): string => (bg !== undefined && line.length > 0 ? applyTextStyles(line, { backgroundColor: bg }) : line)

type TextWrapMode = Parameters<typeof wrapText>[2]

function styledTextFor(segments: StyledSegment[], plainText: string, maxWidth: number, textWrap: TextWrapMode, needsWrapping: boolean): { text: string; softWrap: boolean[] | undefined } {
  const lone = segments.length === 1
  if (needsWrapping && lone) {
    const wrapped = wrapWithSoftWrap(plainText, maxWidth, textWrap)
    return { text: wrapped.wrapped.split('\n').map(line => styleRun(segments, 0, line)).join('\n'), softWrap: wrapped.softWrap }
  } else if (needsWrapping && textWrap.startsWith('truncate')) {
    return { text: styleTruncatedLines(plainText, segments, buildCharToSegmentMap(segments), maxWidth, textWrap), softWrap: undefined }
  } else if (needsWrapping && segments.length > 1) {
    const wraps = textWrap === 'wrap' || textWrap === 'wrap-trim'
    const form = wraps ? wrapperNormalForm(segments, plainText) : { plain: plainText, charToSegment: buildCharToSegmentMap(segments) }
    const wrapped = wrapWithSoftWrap(form.plain, maxWidth, textWrap)
    const softWrap = wrapped.softWrap
    const text = applyStylesToWrappedText(
      wrapped.wrapped, segments, form.charToSegment, form.plain, textWrap === 'wrap-trim',
      textWrap === 'wrap' ? softWrap : undefined,
    )
    return { text, softWrap }
  }
  return { text: segments.map((segment, index) => styleRun(segments, index, segment.text)).join(''), softWrap: undefined }
}

function composeText(node: FrameNode, walk: Walk, x: number, y: number, layoutNode: LayoutNode, inheritedBackgroundColor: Color | undefined, inheritedRowBg?: RowGround): PaintedExtent | undefined {
  let segments = squashTextNodesToSegments(node, inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined)
  if (segments.some(s => s.text.includes('\t'))) {
    let column: number = 0
    segments = segments.map(s => {
      const expanded = expandTabsWithColumn(s.text, column)
      column = expanded.column
      return expanded.text === s.text ? s : { ...s, text: expanded.text }
    })
  }
  const plainText = segments.map(run => run.text).join('')
  if (plainText.length === 0) return undefined
  const maxWidth = Math.min(getMaxWidth(layoutNode), walk.buffer.width - x)
  const { textWrap = 'wrap' } = node.style
  const widest = widestLine(plainText)
  const { text, softWrap } = styledTextFor(segments, plainText, maxWidth, textWrap, widest > maxWidth)
  const padded = applyPaddingToText(node, text, softWrap)
  const sampled = inheritedRowBg !== undefined && inheritedBackgroundColor === undefined
  const grounded = sampled ? padded.split('\n').map((line, k) => rowGrounded(line, inheritedRowBg(y + k))).join('\n') : padded
  walk.buffer.write(x, y, grounded, softWrap)
  let paintedHeight = 1
  for (let i = 0; i < padded.length; i++) {
    if (padded.charCodeAt(i) === 10) paintedHeight++
  }
  const offsetLeft = firstChildOffset(node)?.left ?? 0
  const layoutWidth = layoutNode.getComputedWidth()
  const paintedWidth = offsetLeft + widest > layoutWidth ? widestLine(padded) : layoutWidth
  return { width: paintedWidth, height: paintedHeight }
}

function fillGround(buffer: ComposeBuffer, x: number, y: number, columns: number, rows: number, bg: Color | undefined): void {
  if (columns <= 0 || rows <= 0) return
  buffer.fill(x, y, columns, rows, bg ? applyTextStyles(' ', { backgroundColor: bg }) : undefined)
}

type FillMemo = {
  __prevOwnBg?: unknown
  __prevUniformBg?: unknown
  __prevOpaque?: boolean
  __prevOwnRowBg?: boolean
  __prevRowSampler?: boolean
}

function composeBox(node: FrameNode, walk: Walk, placement: Placement, x: number, y: number, width: number, height: number, layoutNode: LayoutNode, hasRemovedChild: boolean): void {
  const { buffer } = walk
  const ownRowBg = node.style.fillRowBg
  const ownGround = node.style.backgroundColor
  const rowSampler = ownGround !== undefined ? undefined : ((ownRowBg as RowGround | undefined) ?? placement.inheritedRowBg)
  const boxBackgroundColor = ownGround ?? (rowSampler !== undefined ? undefined : placement.inheritedBackgroundColor)
  const exclusion = node.style.noSelect
  if (exclusion) {
    const boxLeft = Math.floor(x)
    const fromEdge = exclusion === 'from-left-edge'
    buffer.noSelect({ x: fromEdge ? 0 : boxLeft, y: Math.floor(y), width: fromEdge ? boxLeft + Math.floor(width) : Math.floor(width), height: Math.floor(height) })
  }
  const across = node.style.overflowX ?? node.style.overflow
  const down = node.style.overflowY ?? node.style.overflow
  const clipsAcross = clipping(across)
  const clipsDown = clipping(down)
  const clips = clipsAcross || clipsDown
  const clipTop = clipsDown ? y + layoutNode.getComputedBorder(LayoutEdge.Top) : undefined
  const clipBottom = clipsDown ? y + layoutNode.getComputedHeight() - layoutNode.getComputedBorder(LayoutEdge.Bottom) : undefined
  if (clips) {
    const clipLeft = clipsAcross ? x + layoutNode.getComputedBorder(LayoutEdge.Left) : undefined
    const clipRight = clipsAcross ? x + layoutNode.getComputedWidth() - layoutNode.getComputedBorder(LayoutEdge.Right) : undefined
    buffer.clip({ x1: clipLeft, x2: clipRight, y1: clipTop, y2: clipBottom })
  }
  const memo = node as unknown as FillMemo
  const prevOwnBg = memo.__prevOwnBg
  const prevUniformBg = memo.__prevUniformBg
  const prevOpaque = memo.__prevOpaque
  const prevOwnRowBg = memo.__prevOwnRowBg
  const prevRowSampler = memo.__prevRowSampler
  const isOpaque = node.style.opaque === true
  const fillRemoved = (prevOwnBg !== undefined && ownGround === undefined) || (prevOpaque === true && !isOpaque) || (prevOwnRowBg === true && ownRowBg === undefined)
  memo.__prevOwnBg = ownGround
  memo.__prevUniformBg = boxBackgroundColor
  memo.__prevOpaque = isOpaque
  memo.__prevOwnRowBg = ownRowBg !== undefined
  memo.__prevRowSampler = rowSampler !== undefined
  if (down === 'scroll') {
    const scrollPlacement = prevOwnBg !== ownGround ? { ...placement, prevScreen: undefined } : placement
    composeScrollBox(node, walk, scrollPlacement, x, y, width, height, layoutNode, clipTop, clipBottom, hasRemovedChild, boxBackgroundColor, ownWithin(placement.own, clipsAcross, clipsDown, x, y, width, height), rowSampler)
  } else {
    const fills = Boolean(ownGround || isOpaque || ownRowBg !== undefined || fillRemoved)
    if (fills) fillInterior(walk, layoutNode, x, y, width, height, ownGround, rowSampler, placement.inheritedBackgroundColor)
    const fillHeld = nodeCache.has(node) && !fillRemoved && prevUniformBg === boxBackgroundColor && prevOpaque === isOpaque && rowSampler === undefined && prevRowSampler === false
    composeChildren(node, walk, x, y, hasRemovedChild, !fills || fillHeld ? placement.prevScreen : undefined, boxBackgroundColor, rowSampler, ownWithin(placement.own, clipsAcross, clipsDown, x, y, width, height))
  }
  if (clips) buffer.unclip()
  renderBorder(x, y, node, buffer as never, boxBackgroundColor)
}

function fillInterior(walk: Walk, layoutNode: LayoutNode, x: number, y: number, width: number, height: number, ownBackgroundColor: Color | undefined, rowSampler: RowGround | undefined, inheritedBackgroundColor: Color | undefined): void {
  const borderLeft = layoutNode.getComputedBorder(LayoutEdge.Left)
  const borderRight = layoutNode.getComputedBorder(LayoutEdge.Right)
  const borderTop = layoutNode.getComputedBorder(LayoutEdge.Top)
  const borderBottom = layoutNode.getComputedBorder(LayoutEdge.Bottom)
  const columns = Math.floor(width) - borderLeft - borderRight
  const rows = Math.floor(height) - borderTop - borderBottom
  if (columns <= 0 || rows <= 0) return
  const uniformFillBg = ownBackgroundColor ?? (rowSampler !== undefined ? undefined : inheritedBackgroundColor)
  if (uniformFillBg === undefined && rowSampler !== undefined) {
    const rowTop = y + borderTop
    for (let r = 0; r < rows; r++) fillGround(walk.buffer, x + borderLeft, rowTop + r, columns, 1, rowSampler(rowTop + r))
  } else {
    fillGround(walk.buffer, x + borderLeft, y + borderTop, columns, rows, uniformFillBg)
  }
}

type RectShift = { top: number; bottom: number; delta: number; x0: number; x1: number }

function composeScrollBox(node: FrameNode, walk: Walk, placement: Placement, x: number, y: number, width: number, height: number, layoutNode: LayoutNode, y1: number | undefined, y2: number | undefined, hasRemovedChild: boolean, boxBackgroundColor: Color | undefined, own: Own, rowSampler?: RowGround): void {
  const { buffer, signals } = walk
  const inOuterScroll = walk.scrollDepth > 0
  if (inOuterScroll) walk.sawInnerScroll = true
  const prevScreen = inOuterScroll ? undefined : placement.prevScreen
  const boxCached = nodeCache.get(node)
  const paddingTop = layoutNode.getComputedPadding(LayoutEdge.Top)
  const paddingBottom = layoutNode.getComputedPadding(LayoutEdge.Bottom)
  const innerHeight = Math.max(0, (y2 ?? y + height) - (y1 ?? y) - paddingTop - paddingBottom)
  const content = node.childNodes.find(c => (c as FrameNode).layoutNode) as FrameNode | undefined
  const contentYoga = content?.layoutNode
  const scroll = (node.scroll ??= {})
  const contentHeight = contentYoga?.getComputedHeight() ?? 0
  const prevScrollHeight = scroll.scrollHeight ?? contentHeight
  const prevInnerHeight = scroll.scrollViewportHeight ?? innerHeight
  scroll.scrollHeight = contentHeight
  scroll.scrollViewportHeight = innerHeight
  scroll.scrollViewportTop = (y1 ?? y) + paddingTop
  const maxScroll = Math.max(0, contentHeight - innerHeight)
  fluxMark('scroll:compose', contentHeight * 100000 + (scroll.scrollTop ?? 0))

  const contentRoot = node.childNodes[0]
  const anchorTop = (start: FrameNode): number | undefined => {
    let el: FrameNode | undefined = start
    let climbed = 0
    let hops = 0
    while (el && el !== node && el !== contentRoot && hops < 100) {
      const top = el.layoutNode?.getComputedTop()
      if (top == null) return undefined
      climbed += top
      el = el.parentNode ?? undefined
      hops++
    }
    return el === contentRoot && Number.isFinite(climbed) ? climbed : undefined
  }
  let anchored = false
  if (scroll.scrollAnchor) {
    const seekTop = anchorTop(scroll.scrollAnchor.el)
    if (seekTop != null) {
      scroll.scrollTop = seekTop + scroll.scrollAnchor.offset
      anchored = true
      scroll.pendingScrollDelta = undefined
    }
    scroll.scrollAnchor = undefined
  }

  const scrollTopBeforeFollow = scroll.scrollTop ?? 0
  const sticky = scroll.stickyScroll ?? Boolean(node.attributes['stickyScroll'])
  const lastMaxScroll = Math.max(0, prevScrollHeight - prevInnerHeight)
  const grew = contentHeight >= prevScrollHeight
  const restingAtBottom = !anchored && grew && scrollTopBeforeFollow >= lastMaxScroll && scroll.lastStableAtBottom !== false
  if ((sticky || restingAtBottom) && (scroll.pendingScrollDelta ?? 0) >= 0) {
    scroll.scrollTop = maxScroll
    scroll.pendingScrollDelta = undefined
    if (scroll.stickyScroll === false && scrollTopBeforeFollow >= lastMaxScroll && scroll.lastStableAtBottom !== false) {
      scroll.stickyScroll = true
      fluxMark('scroll:restick', innerHeight)
    }
  }

  let travel = scroll.scrollTop ?? 0
  const pending = scroll.pendingScrollDelta
  const clampMin = scroll.scrollClampMin
  const clampMax = scroll.scrollClampMax
  const haveClamp = clampMin !== undefined && clampMax !== undefined
  const draining = pending !== undefined && pending !== 0
  if (draining) {
    const pastClamp = haveClamp && ((pending < 0 && travel < clampMin) || (pending > 0 && travel > clampMax))
    const drainHeight = pastClamp ? Math.min(4, innerHeight >> 3) : innerHeight
    travel += hostIsXtermJs() ? drainAdaptive(node, pending, drainHeight) : drainProportional(node, pending, drainHeight)
  } else if (pending === 0) scroll.pendingScrollDelta = undefined
  const scrollTop = Math.max(0, Math.min(travel, maxScroll))
  const shrankPastPosition = contentHeight < prevScrollHeight && travel > maxScroll
  const clamped = haveClamp ? Math.max(clampMin, Math.min(scrollTop, clampMax)) : scrollTop
  scroll.scrollTop = shrankPastPosition ? Math.max(0, travel) : scrollTop
  if (grew && maxScroll > 0) {
    const nowAtBottom = scrollTop >= maxScroll
    if (nowAtBottom !== scroll.lastStableAtBottom) fluxMark('scroll:bit', nowAtBottom ? 1 : 0)
    scroll.lastStableAtBottom = nowAtBottom
  }
  if (scrollTop !== travel) scroll.pendingScrollDelta = undefined
  const clampGap = clamped - scrollTop
  if (!inOuterScroll && (scroll.pendingScrollDelta !== undefined || (clampGap !== 0 && clampGap !== (scroll.scrollClampGapPrev ?? 0)))) signals.scrollDrainNode = node
  scroll.scrollClampGapPrev = clampGap
  const paintTop = clamped

  if (!content || !contentYoga) return
  const contentVacated = vacatedRects(content)
  if (contentVacated !== undefined) for (const rect of contentVacated) buffer.clear(floorRect(rect))
  const childRemoved = consumeChildRemoved(content) || hasRemovedChild || contentVacated !== undefined
  const contentLeft = x + contentYoga.getComputedLeft()
  const contentTop = y + contentYoga.getComputedTop() - paintTop
  const bandTop = paintTop - paddingTop
  const bandBottom = paintTop + innerHeight + paddingBottom

  const contentWas = nodeCache.get(content)
  let regionHint: ScrollHint | null = null
  let rectShift: RectShift | null = null
  if (!inOuterScroll && contentWas && contentWas.y !== contentTop) {
    const delta = contentWas.y - contentTop
    const regionTop = Math.floor(y + contentYoga.getComputedTop() - paddingTop)
    const regionBottom = regionTop + paddingTop + innerHeight + paddingBottom - 1
    signals.scrollTranslation = { delta, viewportTop: regionTop, viewportBottom: regionBottom }
    if (delta > 0) fluxMark('scroll:follow', innerHeight)
    fluxMark('scroll:xlate', regionTop * 1000 + delta + 500)
    if (rowSampler === undefined) {
      const spansFullWidth = Math.floor(x) <= 0 && Math.ceil(x + width) >= buffer.width
      const stableForShift =
        boxCached?.x === x &&
        boxCached.y === y &&
        boxCached.width === width &&
        boxCached.height === height &&
        innerHeight > 0 &&
        Math.abs(delta) < innerHeight
      if (stableForShift && spansFullWidth && walk.regionScrollUsable) {
        regionHint = { top: regionTop, bottom: regionBottom, delta }
        signals.scrollHint = regionHint
      } else if (stableForShift) {
        rectShift = { top: regionTop, bottom: regionBottom, delta, x0: Math.floor(x), x1: Math.floor(x) + Math.floor(width) }
      } else {
        signals.markLayoutShift(() => `scroll-no-hint:${node.nodeName}`)
      }
    }
  }

  const contentHeightWas = contentWas?.height ?? contentHeight
  const heightDelta = contentHeight - contentHeightWas
  const shiftPlan = regionHint ?? rectShift
  const contentChildren = content.childNodes as FrameNode[]
  const newlyHiddenCached = shiftPlan !== null && contentChildren.some(ch => ch.layoutNode?.getDisplay() === LayoutDisplay.None && nodeCache.has(ch))
  const firstCached = shiftPlan ? contentChildren.find(ch => ch.layoutNode !== undefined && ch.layoutNode.getDisplay() !== LayoutDisplay.None && nodeCache.has(ch)) : undefined
  let lastCached: FrameNode | undefined
  if (shiftPlan) {
    for (let i = contentChildren.length - 1; i >= 0; i--) {
      const ch = contentChildren[i]!
      if (ch.layoutNode !== undefined && ch.layoutNode.getDisplay() !== LayoutDisplay.None && nodeCache.has(ch)) {
        lastCached = ch
        break
      }
    }
  }
  const anchorShifted =
    !newlyHiddenCached &&
    (firstCached === undefined ||
      Math.floor(nodeCache.get(firstCached)!.y) - shiftPlan!.delta === Math.floor(contentTop + firstCached.layoutNode!.getComputedTop())) &&
    (lastCached === undefined ||
      Math.floor(nodeCache.get(lastCached)!.y) - shiftPlan!.delta === Math.floor(contentTop + lastCached.layoutNode!.getComputedTop()))
  const viewportOverlapsInvalid = shiftPlan !== null && rectsOverlap(x, shiftPlan.top, width, shiftPlan.bottom - shiftPlan.top + 1, walk.invalidRects)
  const wasReaching = hasReachingChild(content)
  if (shiftPlan !== null && content.dirty) {
    for (const entry of content.childNodes) {
      if (entry.nodeName === '#text') continue
      const ch = entry as FrameNode
      if (ch.dirty && ch.layoutNode) {
        setChildReach(content, ch, childStillReaches(ch, contentLeft + ch.layoutNode.getComputedLeft(), contentTop + ch.layoutNode.getComputedTop(), buffer.width))
      }
    }
  }
  const contentHasReach = wasReaching || hasReachingChild(content)
  const contentHasNestedScroll = inOuterScroll || hasNestedScroll(content)
  const safeForFastPath = !shiftPlan || (!childRemoved && !viewportOverlapsInvalid && !contentHasReach && !contentHasNestedScroll && anchorShifted && (heightDelta === 0 || (shiftPlan.delta > 0 && heightDelta === shiftPlan.delta)))
  if (!safeForFastPath) {
    signals.scrollHint = null
    if (rectShift) {
      rectShift = null
      signals.markLayoutShift(() => `scroll-rect-unsafe:${node.nodeName}`)
    }
  }

  const prevSawInner = walk.sawInnerScroll
  if (!inOuterScroll) walk.sawInnerScroll = false
  walk.scrollDepth++
  if ((regionHint || rectShift) && prevScreen && safeForFastPath) {
    const { top, bottom, delta } = (regionHint ?? rectShift)!
    const columns = Math.floor(width)
    buffer.blit(prevScreen, Math.floor(x), top, columns, bottom - top + 1)
    if (regionHint) buffer.shift(top, bottom, delta)
    else buffer.shiftRect(top, bottom, rectShift!.x0, rectShift!.x1, delta)
    shiftScrolledChildrenCache(content, top, bottom + 1, delta)
    const incomingTop = delta > 0 ? bottom - delta + 1 : top
    const incomingBottom = delta > 0 ? bottom : top - delta - 1
    const dirtyChildren = content.dirty ? new Set(content.childNodes.filter(c => (c as FrameNode).dirty)) : null
    if (dirtyChildren !== null) {
      repairStableRows(content, walk, dirtyChildren, contentLeft, contentTop, bandTop, bandBottom, incomingTop, incomingBottom, top, bottom + 1, Math.floor(x), columns, boxBackgroundColor)
    }
    buffer.clear({ x: Math.floor(x), y: incomingTop, width: columns, height: incomingBottom - incomingTop + 1 })
    if (boxBackgroundColor && incomingBottom >= incomingTop) fillGround(buffer, Math.floor(x), incomingTop, columns, incomingBottom - incomingTop + 1, boxBackgroundColor)
    buffer.clip({ x1: undefined, x2: undefined, y1: incomingTop, y2: incomingBottom + 1 })
    composeScrolledChildren(content, walk, contentLeft, contentTop, childRemoved, undefined, incomingTop - contentTop, incomingBottom + 1 - contentTop, boxBackgroundColor, true)
    buffer.unclip()
    for (const rect of walk.prevAbsoluteRects) {
      if (rect.y >= bottom + 1 || rect.y + rect.height <= top || rect.x >= Math.floor(x) + columns || rect.x + rect.width <= Math.floor(x)) continue
      const shiftedTop = Math.max(top, Math.floor(rect.y) - delta)
      const shiftedBottom = Math.min(bottom + 1, Math.floor(rect.y + rect.height) - delta)
      if (shiftedTop >= shiftedBottom || (shiftedTop >= incomingTop && shiftedBottom <= incomingBottom + 1)) continue
      fillGround(buffer, Math.floor(x), shiftedTop, columns, shiftedBottom - shiftedTop, boxBackgroundColor)
      buffer.clip({ x1: undefined, x2: undefined, y1: shiftedTop, y2: shiftedBottom })
      composeScrolledChildren(content, walk, contentLeft, contentTop, childRemoved, undefined, shiftedTop - contentTop, shiftedBottom - contentTop, boxBackgroundColor, true)
      buffer.unclip()
    }
  } else {
    const scrolled = contentWas !== undefined && contentWas.y !== contentTop
    const boxMoved = boxCached !== undefined && (boxCached.x !== x || boxCached.y !== y || boxCached.width !== width || boxCached.height !== height)
    const childPrevScreen = rowSampler !== undefined || scrolled || boxMoved || contentHasNestedScroll ? undefined : prevScreen
    if (scrolled && y1 !== undefined && y2 !== undefined) buffer.clear({ x: Math.floor(x), y: Math.floor(y1), width: Math.floor(width), height: Math.floor(y2 - y1) })
    if (rowSampler !== undefined && y1 !== undefined && y2 !== undefined && Math.floor(width) >= 1) {
      const viewTop = Math.floor(y1)
      const viewBottom = Math.floor(y2)
      for (let row = viewTop; row < viewBottom; row++) fillGround(buffer, Math.floor(x), row, Math.floor(width), 1, rowSampler(row))
    } else if (boxBackgroundColor && y1 !== undefined && y2 !== undefined && (scrolled || !contentWas || childPrevScreen === undefined || node.style.backgroundColor !== undefined) && Math.floor(width) >= 1 && Math.floor(y2 - y1) >= 1) {
      fillGround(buffer, Math.floor(x), Math.floor(y1), Math.floor(width), Math.floor(y2 - y1), boxBackgroundColor)
    }
    composeScrolledChildren(content, walk, contentLeft, contentTop, childRemoved, childPrevScreen, bandTop, bandBottom, boxBackgroundColor, false, rowSampler, own)
  }
  walk.scrollDepth--
  if (!inOuterScroll) {
    setHasNestedScroll(content, walk.sawInnerScroll)
    walk.sawInnerScroll = prevSawInner
  }
  nodeCache.set(content, { x: contentLeft, y: contentTop, width: contentYoga.getComputedWidth(), height: contentYoga.getComputedHeight() })
  settle(content)
}

function shiftSubtreeCache(root: FrameNode, delta: number): void {
  const pending: FrameNode[] = [root]
  while (pending.length > 0) {
    const elem = pending.pop()!
    const cached = nodeCache.get(elem)
    if (cached !== undefined) {
      nodeCache.set(elem, {
        x: cached.x,
        y: cached.y - delta,
        width: cached.width,
        height: cached.height,
        ...(cached.reach !== undefined ? { reach: { ...cached.reach, y: cached.reach.y - delta } } : {}),
      })
    }
    for (const child of elem.childNodes) {
      if (child.nodeName !== '#text') pending.push(child as FrameNode)
    }
  }
}

function shiftScrolledChildrenCache(content: FrameNode, viewTop: number, viewBottom: number, delta: number): void {
  for (const entry of content.childNodes) {
    if (entry.nodeName === '#text') continue
    const child = entry as FrameNode
    const cached = nodeCache.get(child)
    if (cached === undefined) continue
    const shiftedY = cached.y - delta
    if (shiftedY + cached.height <= viewTop || shiftedY >= viewBottom) {
      forgetSubtree(child)
    } else {
      shiftSubtreeCache(child, delta)
    }
  }
}

function repairStableRows(content: FrameNode, walk: Walk, dirtyChildren: Set<FrameNode['childNodes'][number]>, contentLeft: number, contentTop: number, bandTop: number, bandBottom: number, incomingTop: number, incomingBottom: number, regionTop: number, regionFloor: number, left: number, columns: number, boxBackgroundColor: Color | undefined): void {
  const { buffer } = walk
  for (const entry of content.childNodes) {
    const child = entry as FrameNode
    const layout = child.layoutNode
    if (!layout || layout.getDisplay() === LayoutDisplay.None) continue
    const childTop = layout.getComputedTop()
    const childHeight = layout.getComputedHeight()
    const childBottom = childTop + childHeight
    const offscreen = childBottom <= bandTop || childTop >= bandBottom
    const insideIncoming = childTop >= incomingTop - contentTop && childBottom <= incomingBottom + 1 - contentTop
    if (offscreen || insideIncoming) continue
    const isDirty = dirtyChildren.has(entry)
    const screenTop = Math.floor(contentTop + childTop)
    const childWas = isDirty ? undefined : nodeCache.get(child)
    if (childWas !== undefined && Math.floor(childWas.y) === screenTop && childWas.height === childHeight) continue
    const clipStart = Math.max(regionTop, screenTop)
    const screenBottom = Math.min(Math.floor(contentTop + childBottom), regionFloor)
    if (clipStart < screenBottom) {
      fillGround(buffer, left, clipStart, columns, screenBottom - clipStart, boxBackgroundColor)
      buffer.clip({ x1: undefined, x2: undefined, y1: clipStart, y2: screenBottom })
      composeNode(child, walk, { offsetX: contentLeft, offsetY: contentTop, prevScreen: undefined, inheritedBackgroundColor: boxBackgroundColor })
      buffer.unclip()
    }
  }
}

type ScreenOffer = 'open' | 'clipped' | 'closed'

function composeChildren(node: FrameNode, walk: Walk, offsetX: number, offsetY: number, hasRemovedChild: boolean, prevScreen: Screen | undefined, inheritedBackgroundColor: Color | undefined, inheritedRowBg: RowGround | undefined, own: Own | undefined): void {
  const children = node.childNodes as FrameNode[]
  let offer: ScreenOffer = hasRemovedChild || children.some(reachMoves) ? 'closed' : 'open'
  for (const child of children) {
    const hidden = child.layoutNode?.getDisplay() === LayoutDisplay.None
    const wasDirty = !hidden && child.dirty
    const floating = child.style.position === 'absolute'
    const seeThrough = floating && !child.style.opaque && child.style.backgroundColor === undefined
    const repainted = composeNode(child, walk, { offsetX, offsetY, prevScreen: offer === 'closed' ? undefined : prevScreen, skipSelfBlit: offer === 'clipped' && seeThrough, inheritedBackgroundColor, inheritedRowBg, own: floating ? undefined : own })
    if ((wasDirty || repainted) && offer !== 'closed') offer = !floating && !hidden && clipsBothAxes(child) ? 'clipped' : 'closed'
  }
}

function clipsBothAxes(node: FrameNode): boolean {
  return clipping(node.style.overflowX ?? node.style.overflow) && clipping(node.style.overflowY ?? node.style.overflow)
}

function nearestLaidOutSibling(siblings: FrameNode['childNodes'], index: number): LayoutNode | null {
  const after = siblings.slice(index + 1).find(sibling => (sibling as FrameNode).layoutNode)
  const before = siblings.slice(0, index).reverse().find(sibling => (sibling as FrameNode).layoutNode)
  return ((after ?? before) as FrameNode | undefined)?.layoutNode ?? null
}

function siblingSharesY(node: FrameNode, layoutNode: LayoutNode): boolean {
  const siblings = node.parentNode?.childNodes
  if (siblings === undefined) return false
  const neighbour = nearestLaidOutSibling(siblings, siblings.indexOf(node))
  return neighbour !== null && neighbour.getComputedTop() === layoutNode.getComputedTop()
}

function pushElementChildren(stack: FrameNode[], parent: FrameNode): void {
  for (let i = parent.childNodes.length - 1; i >= 0; i--) {
    const child = parent.childNodes[i]!
    if (child.nodeName !== '#text') stack.push(child as FrameNode)
  }
}

function restoreIfEscaping(walk: Walk, prevScreen: Screen, rect: Rectangle, left: number, top: number, right: number, bottom: number): void {
  const whole = floorRect(rect)
  const inside = whole.x >= left && whole.y >= top && whole.x + whole.width <= right && whole.y + whole.height <= bottom
  if (!inside) walk.buffer.blit(prevScreen, whole.x, whole.y, whole.width, whole.height)
}

function blitEscapingAbsoluteDescendants(node: FrameNode, walk: Walk, prevScreen: Screen, left: number, top: number, columns: number, rows: number): void {
  const right = left + columns
  const bottom = top + rows
  const pending: FrameNode[] = []
  pushElementChildren(pending, node)
  while (pending.length > 0) {
    const elem = pending.pop()!
    const cachedElem = nodeCache.get(elem)
    if (elem.style.position === 'absolute' && cachedElem !== undefined) {
      walk.signals.absoluteRectsCur.push(cachedElem)
      walk.signals.absoluteEntriesCur.push({ node: elem, rect: cachedElem })
      restoreIfEscaping(walk, prevScreen, cachedElem, left, top, right, bottom)
    } else if (cachedElem?.reach !== undefined) {
      walk.signals.reachRectsCur.push(cachedElem.reach)
    }
    pushElementChildren(pending, elem)
  }
}

const outsideBand = (layout: LayoutNode, bandTop: number, bandBottom: number): boolean => layout.getComputedTop() + layout.getComputedHeight() <= bandTop || layout.getComputedTop() >= bandBottom

function measureLeafExtent(node: FrameNode, layoutNode: LayoutNode, maxBufWidth: number, x: number): PaintedExtent | undefined {
  if (node.nodeName === 'ink-raw-ansi') {
    const rawText = node.attributes['rawText'] as string
    if (!rawText) return undefined
    let rows = 1
    for (let i = 0; i < rawText.length; i++) if (rawText.charCodeAt(i) === 10) rows++
    const width = layoutNode.getComputedWidth()
    const rawW = Number(node.attributes['rawWidth'] ?? 0)
    return { width: rawW > width ? rawW : widestLine(rawText), height: rows }
  }
  if (node.nodeName === 'ink-text') {
    let segments = squashTextNodesToSegments(node)
    if (segments.some(s => s.text.includes('\t'))) {
      let column = 0
      segments = segments.map(s => {
        const expanded = expandTabsWithColumn(s.text, column)
        column = expanded.column
        return expanded.text === s.text ? s : { ...s, text: expanded.text }
      })
    }
    const plainText = segments.map(run => run.text).join('')
    if (plainText.length === 0) return undefined
    const maxWidth = Math.min(getMaxWidth(layoutNode), maxBufWidth - x)
    const { textWrap = 'wrap' } = node.style
    const widest = widestLine(plainText)
    const { text, softWrap } = styledTextFor(segments, plainText, maxWidth, textWrap, widest > maxWidth)
    const padded = applyPaddingToText(node, text, softWrap)
    let paintedHeight = 1
    for (let i = 0; i < padded.length; i++) if (padded.charCodeAt(i) === 10) paintedHeight++
    const offsetLeft = firstChildOffset(node)?.left ?? 0
    const layoutWidth = layoutNode.getComputedWidth()
    return { width: offsetLeft + widest > layoutWidth ? widestLine(padded) : layoutWidth, height: paintedHeight }
  }
  return undefined
}

function nodePaintedBounds(node: FrameNode, x: number, y: number, maxBufWidth: number): Rectangle | undefined {
  const { layoutNode } = node
  if (!layoutNode || layoutNode.getDisplay() === LayoutDisplay.None) return undefined
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()
  if (height === 0 && siblingSharesY(node, layoutNode)) return { x, y, width, height }
  if (node.nodeName !== 'ink-box') {
    const leaf = measureLeafExtent(node, layoutNode, maxBufWidth, x)
    if (leaf === undefined) return { x, y, width, height }
    return { x, y, width: Math.max(width, leaf.width), height: Math.max(height, leaf.height) }
  }
  const clipsAcross = clipping(node.style.overflowX ?? node.style.overflow)
  const clipsDown = clipping(node.style.overflowY ?? node.style.overflow)
  if (clipsAcross && clipsDown) return { x, y, width, height }
  let left = x
  let top = y
  let right = x + width
  let bottom = y + height
  for (const entry of node.childNodes) {
    if (entry.nodeName === '#text') continue
    const child = entry as FrameNode
    if (child.style.position === 'absolute' || !child.layoutNode) continue
    const cx = x + child.layoutNode.getComputedLeft()
    const cy = y + child.layoutNode.getComputedTop()
    const painted = nodePaintedBounds(child, cx, cy, maxBufWidth)
    if (painted === undefined) continue
    if (!clipsAcross) {
      left = Math.min(left, painted.x)
      right = Math.max(right, painted.x + painted.width)
    }
    if (!clipsDown) {
      top = Math.min(top, painted.y)
      bottom = Math.max(bottom, painted.y + painted.height)
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function childStillReaches(child: FrameNode, cx: number, cy: number, maxBufWidth: number): boolean {
  const { layoutNode } = child
  if (!layoutNode || layoutNode.getDisplay() === LayoutDisplay.None) return false
  const cw = layoutNode.getComputedWidth()
  const ch = layoutNode.getComputedHeight()
  const bounds = nodePaintedBounds(child, cx, cy, maxBufWidth)
  return bounds !== undefined && (bounds.x < cx || bounds.y < cy || bounds.x + bounds.width > cx + cw || bounds.y + bounds.height > cy + ch)
}

function composeScrolledChildren(node: FrameNode, walk: Walk, offsetX: number, offsetY: number, hasRemovedChild: boolean, prevScreen: Screen | undefined, scrollTopY: number, scrollBottomY: number, inheritedBackgroundColor: Color | undefined, preserveCulledCache = false, inheritedRowBg?: RowGround, own?: Own): void {
  const children = node.childNodes as FrameNode[]
  let offerOpen = !hasRemovedChild && !children.some(reachMoves)
  for (const child of children) {
    const layout = child.layoutNode
    if (layout === undefined || layout.getDisplay() === LayoutDisplay.None) {
      if (layout !== undefined && clearHidden(child, walk)) offerOpen = false
      continue
    }
    const culled = outsideBand(layout, scrollTopY, scrollBottomY)
    if (culled && !preserveCulledCache) {
      if (child.dirty) {
        setChildReach(node, child, childStillReaches(child, offsetX + layout.getComputedLeft(), offsetY + layout.getComputedTop(), walk.buffer.width))
      }
      forgetSubtree(child)
    }
    if (culled) continue
    const wasDirty = child.dirty
    const repainted = composeNode(child, walk, { offsetX, offsetY, prevScreen: offerOpen ? prevScreen : undefined, inheritedBackgroundColor, inheritedRowBg, own })
    if (wasDirty || (repainted && !clipsBothAxes(child))) offerOpen = false
  }
}

function forgetSubtree(root: FrameNode): void {
  const pending: FrameNode[] = [root]
  while (pending.length > 0) {
    const forgotten = pending.pop()!
    nodeCache.delete(forgotten)
    for (const child of forgotten.childNodes) {
      if (child.nodeName !== '#text') pending.push(child as FrameNode)
    }
  }
}
