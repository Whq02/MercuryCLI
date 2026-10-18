import indentString from 'indent-string'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { applyTextStyles } from './colorize.js'
import { expandTabsWithColumn } from './tabstops.js'
import type { DOMElement as FrameNode } from './dom.js'
import getMaxWidth from './get-max-width.js'
import type { Rectangle } from './layout/geometry.js'
import { LayoutDisplay, LayoutEdge, type LayoutNode } from './layout/node.js'
import { type CachedLayout, nodeCache, pendingClears } from './node-cache.js'
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

type Walk = { buffer: ComposeBuffer; signals: ComposeSignals; prevAbsoluteRects: readonly Rectangle[]; regionScrollUsable: boolean }

type Placement = { offsetX?: number; offsetY?: number; prevScreen: Screen | undefined; skipSelfBlit?: boolean; inheritedBackgroundColor?: Color; inheritedRowBg?: RowGround }

type ComposeOptions = { offsetX?: number; offsetY?: number; prevScreen: Screen | undefined; signals?: ComposeSignals; prevAbsoluteRects?: readonly Rectangle[]; regionScrollUsable?: boolean }

const floorRect = (rect: Rectangle): Rectangle => ({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) })

const clipping = (mode: string | undefined): boolean => mode === 'hidden' || mode === 'scroll'

export default function composeTree(root: FrameNode, buffer: ComposeBuffer, opts: ComposeOptions): ComposeSignals {
  const walk: Walk = { buffer, signals: opts.signals ?? new ComposeSignals(), prevAbsoluteRects: opts.prevAbsoluteRects ?? [], regionScrollUsable: opts.regionScrollUsable === true }
  composeNode(root, walk, { offsetX: opts.offsetX, offsetY: opts.offsetY, prevScreen: opts.prevScreen })
  return walk.signals
}

function composeNode(node: FrameNode, walk: Walk, placement: Placement): void {
  const { layoutNode } = node
  if (!layoutNode) return
  if (layoutNode.getDisplay() === LayoutDisplay.None) clearHidden(node, walk)
  else placeNode(node, layoutNode, walk, placement)
}

function clearHidden(hidden: FrameNode, walk: Walk): void {
  const cached = hidden.dirty ? nodeCache.get(hidden) : undefined
  if (cached === undefined) return
  walk.buffer.clear(floorRect(cached))
  forgetSubtree(hidden)
  walk.signals.markLayoutShift(() => `display-none-clear:${hidden.nodeName}`, Math.floor(cached.y))
}

function placeNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement): void {
  const x = (placement.offsetX ?? 0) + layoutNode.getComputedLeft()
  const yogaTop = layoutNode.getComputedTop()
  const floating = node.style.position === 'absolute'
  const unclampedY = (placement.offsetY ?? 0) + yogaTop
  const y = unclampedY < 0 && floating ? 0 : unclampedY
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()
  const held = nodeCache.get(node)
  const rectHeld = held !== undefined && held.x === x && held.y === y && held.width === width && held.height === height
  const reusable = !node.dirty && !placement.skipSelfBlit && node.scroll?.pendingScrollDelta === undefined && rectHeld && placement.prevScreen !== undefined
  if (reusable) reuseNode(node, held!, walk, placement.prevScreen!, floating, x, y, width, height)
  else repaintNode(node, layoutNode, walk, placement, held, rectHeld, floating, x, y, yogaTop, width, height)
}

function reuseNode(node: FrameNode, cached: CachedLayout, walk: Walk, prevScreen: Screen, floating: boolean, x: number, y: number, width: number, height: number): void {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const columns = Math.floor(width)
  const rows = Math.floor(height)
  walk.buffer.blit(prevScreen, left, top, columns, rows)
  if (floating) walk.signals.absoluteRectsCur.push(cached)
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

function repaintNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement, cached: CachedLayout | undefined, rectHeld: boolean, floating: boolean, x: number, y: number, yogaTop: number, width: number, height: number): void {
  const { buffer, signals } = walk
  const moved = cached !== undefined && !rectHeld
  if (moved) signals.markLayoutShift(() => movedForensics(node, cached, x, y, width, height), firstDivergentRow(cached, y, height))
  if (cached && (node.dirty || moved)) buffer.clear(floorRect(cached), floating)
  const vacated = vacatedRects(node)
  const hasRemovedChild = vacated !== undefined
  if (vacated !== undefined) {
    signals.markLayoutShift(() => `removed-child:${node.nodeName}`, vacated.length > 0 ? Math.min(...vacated.map(rect => Math.floor(rect.y))) : undefined)
    for (const rect of vacated) buffer.clear(floorRect(rect))
  }
  const placed: CachedLayout = { x, y, width, height, top: yogaTop }
  if (height === 0 && siblingSharesY(node, layoutNode)) {
    nodeCache.set(node, placed)
    forgetSubtree(node)
  } else {
    paintNode(node, layoutNode, walk, placement, x, y, width, height, hasRemovedChild)
    nodeCache.set(node, placed)
    if (floating) signals.absoluteRectsCur.push(placed)
  }
  settle(node)
}

function vacatedRects(parent: FrameNode): readonly Rectangle[] | undefined {
  const rects = pendingClears.get(parent)
  if (rects !== undefined) pendingClears.delete(parent)
  return rects
}

const settle = (painted: FrameNode): void => {
  painted.dirty = false
}

function paintNode(node: FrameNode, layoutNode: LayoutNode, walk: Walk, placement: Placement, x: number, y: number, width: number, height: number, hasRemovedChild: boolean): void {
  const kind = node.nodeName
  if (kind === 'ink-raw-ansi') {
    const rawText = node.attributes['rawText'] as string
    if (rawText) walk.buffer.write(x, y, rawText)
  } else if (kind === 'ink-text') {
    composeText(node, walk, x, y, layoutNode, placement.inheritedBackgroundColor, placement.inheritedRowBg)
  } else if (kind === 'ink-box') {
    composeBox(node, walk, placement, x, y, width, height, layoutNode, hasRemovedChild)
  } else if (kind === 'ink-root') {
    composeChildren(node, walk, x, y, hasRemovedChild, placement.prevScreen, placement.inheritedBackgroundColor, placement.inheritedRowBg)
  }
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

function composeText(node: FrameNode, walk: Walk, x: number, y: number, layoutNode: LayoutNode, inheritedBackgroundColor: Color | undefined, inheritedRowBg?: RowGround): void {
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
  if (plainText.length === 0) return
  const maxWidth = Math.min(getMaxWidth(layoutNode), walk.buffer.width - x)
  const { textWrap = 'wrap' } = node.style
  const widest = widestLine(plainText)
  const { text, softWrap } = styledTextFor(segments, plainText, maxWidth, textWrap, widest > maxWidth)
  const padded = applyPaddingToText(node, text, softWrap)
  const sampled = inheritedRowBg !== undefined && inheritedBackgroundColor === undefined
  const grounded = sampled ? padded.split('\n').map((line, k) => rowGrounded(line, inheritedRowBg(y + k))).join('\n') : padded
  walk.buffer.write(x, y, grounded, softWrap)
}

function groundRows(columns: number, rows: number, bg: Color | undefined): string {
  const blank = ' '.repeat(columns)
  const row = bg ? applyTextStyles(blank, { backgroundColor: bg }) : blank
  return Array(rows).fill(row).join('\n')
}

type FillMemo = { __prevOwnBg?: unknown; __prevOpaque?: boolean; __prevOwnRowBg?: boolean }

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
  if (down === 'scroll') {
    composeScrollBox(node, walk, placement, x, y, width, height, layoutNode, clipTop, clipBottom, hasRemovedChild, boxBackgroundColor, rowSampler)
  } else {
    const memo = node as unknown as FillMemo
    const fillRemoved = (memo.__prevOwnBg !== undefined && ownGround === undefined) || (memo.__prevOpaque === true && node.style.opaque !== true) || (memo.__prevOwnRowBg === true && ownRowBg === undefined)
    memo.__prevOwnBg = ownGround
    memo.__prevOpaque = node.style.opaque === true
    memo.__prevOwnRowBg = ownRowBg !== undefined
    const fills = Boolean(ownGround || node.style.opaque || ownRowBg !== undefined || fillRemoved)
    if (fills) fillInterior(walk, layoutNode, x, y, width, height, ownGround, rowSampler, placement.inheritedBackgroundColor)
    composeChildren(node, walk, x, y, hasRemovedChild, fills ? undefined : placement.prevScreen, boxBackgroundColor, rowSampler)
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
    for (let r = 0; r < rows; r++) walk.buffer.write(x + borderLeft, rowTop + r, groundRows(columns, 1, rowSampler(rowTop + r)))
  } else {
    walk.buffer.write(x + borderLeft, y + borderTop, groundRows(columns, rows, uniformFillBg))
  }
}

type RectShift = { top: number; bottom: number; delta: number; x0: number; x1: number }

function composeScrollBox(node: FrameNode, walk: Walk, placement: Placement, x: number, y: number, width: number, height: number, layoutNode: LayoutNode, y1: number | undefined, y2: number | undefined, hasRemovedChild: boolean, boxBackgroundColor: Color | undefined, rowSampler?: RowGround): void {
  const { buffer, signals } = walk
  const prevScreen = placement.prevScreen
  const boxCached = nodeCache.get(node)
  const paddingTop = layoutNode.getComputedPadding(LayoutEdge.Top)
  const innerHeight = Math.max(0, (y2 ?? y + height) - (y1 ?? y) - paddingTop - layoutNode.getComputedPadding(LayoutEdge.Bottom))
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
  if (scroll.pendingScrollDelta !== undefined || (clampGap !== 0 && clampGap !== (scroll.scrollClampGapPrev ?? 0))) signals.scrollDrainNode = node
  scroll.scrollClampGapPrev = clampGap
  const paintTop = clamped

  if (!content || !contentYoga) return
  const contentLeft = x + contentYoga.getComputedLeft()
  const contentTop = y + contentYoga.getComputedTop() - paintTop

  const contentWas = nodeCache.get(content)
  let regionHint: ScrollHint | null = null
  let rectShift: RectShift | null = null
  if (contentWas && contentWas.y !== contentTop) {
    const delta = contentWas.y - contentTop
    const viewportTop = Math.floor(y + contentYoga.getComputedTop())
    const viewportBottom = viewportTop + innerHeight - 1
    signals.scrollTranslation = { delta, viewportTop, viewportBottom }
    if (delta > 0) fluxMark('scroll:follow', innerHeight)
    fluxMark('scroll:xlate', viewportTop * 1000 + delta + 500)
    if (rowSampler === undefined) {
      const spansFullWidth = Math.floor(x) <= 0 && Math.ceil(x + width) >= buffer.width
      const stableForShift = boxCached?.y === y && boxCached.height === height && innerHeight > 0 && Math.abs(delta) < innerHeight
      if (stableForShift && spansFullWidth && walk.regionScrollUsable) {
        regionHint = { top: viewportTop, bottom: viewportBottom, delta }
        signals.scrollHint = regionHint
      } else if (stableForShift) {
        rectShift = { top: viewportTop, bottom: viewportBottom, delta, x0: Math.floor(x), x1: Math.floor(x) + Math.floor(width) }
      } else {
        signals.markLayoutShift(() => `scroll-no-hint:${node.nodeName}`)
      }
    }
  }

  const contentHeightWas = contentWas?.height ?? contentHeight
  const heightDelta = contentHeight - contentHeightWas
  const shiftPlan = regionHint ?? rectShift
  const safeForFastPath = !shiftPlan || heightDelta === 0 || (shiftPlan.delta > 0 && heightDelta === shiftPlan.delta)
  if (!safeForFastPath) {
    signals.scrollHint = null
    if (rectShift) {
      rectShift = null
      signals.markLayoutShift(() => `scroll-rect-unsafe:${node.nodeName}`)
    }
  }

  if ((regionHint || rectShift) && prevScreen && safeForFastPath) {
    const { top, bottom, delta } = (regionHint ?? rectShift)!
    const columns = Math.floor(width)
    buffer.blit(prevScreen, Math.floor(x), top, columns, bottom - top + 1)
    if (regionHint) buffer.shift(top, bottom, delta)
    else buffer.shiftRect(top, bottom, rectShift!.x0, rectShift!.x1, delta)
    const incomingTop = delta > 0 ? bottom - delta + 1 : top
    const incomingBottom = delta > 0 ? bottom : top - delta - 1
    buffer.clear({ x: Math.floor(x), y: incomingTop, width: columns, height: incomingBottom - incomingTop + 1 })
    if (boxBackgroundColor && incomingBottom >= incomingTop) buffer.write(Math.floor(x), incomingTop, groundRows(columns, incomingBottom - incomingTop + 1, boxBackgroundColor))
    buffer.clip({ x1: undefined, x2: undefined, y1: incomingTop, y2: incomingBottom + 1 })
    const dirtyChildren = content.dirty ? new Set(content.childNodes.filter(c => (c as FrameNode).dirty)) : null
    composeScrolledChildren(content, walk, contentLeft, contentTop, hasRemovedChild, undefined, incomingTop - contentTop, incomingBottom + 1 - contentTop, boxBackgroundColor, true)
    buffer.unclip()
    if (dirtyChildren !== null) {
      const viewportFloor = Math.floor((y1 ?? y) + paddingTop + innerHeight)
      repairStableRows(content, walk, dirtyChildren, contentLeft, contentTop, delta, paintTop, innerHeight, incomingTop, incomingBottom, viewportFloor, Math.floor(x), columns, boxBackgroundColor)
    }
    for (const rect of walk.prevAbsoluteRects) {
      if (rect.y >= bottom + 1 || rect.y + rect.height <= top) continue
      const shiftedTop = Math.max(top, Math.floor(rect.y) - delta)
      const shiftedBottom = Math.min(bottom + 1, Math.floor(rect.y + rect.height) - delta)
      if (shiftedTop >= shiftedBottom || (shiftedTop >= incomingTop && shiftedBottom <= incomingBottom + 1)) continue
      buffer.write(Math.floor(x), shiftedTop, groundRows(columns, shiftedBottom - shiftedTop, boxBackgroundColor))
      buffer.clip({ x1: undefined, x2: undefined, y1: shiftedTop, y2: shiftedBottom })
      composeScrolledChildren(content, walk, contentLeft, contentTop, hasRemovedChild, undefined, shiftedTop - contentTop, shiftedBottom - contentTop, boxBackgroundColor, true)
      buffer.unclip()
    }
  } else {
    const scrolled = contentWas !== undefined && contentWas.y !== contentTop
    if (scrolled && y1 !== undefined && y2 !== undefined) buffer.clear({ x: Math.floor(x), y: Math.floor(y1), width: Math.floor(width), height: Math.floor(y2 - y1) })
    if (rowSampler !== undefined && y1 !== undefined && y2 !== undefined && Math.floor(width) >= 1) {
      const viewTop = Math.floor(y1)
      const viewBottom = Math.floor(y2)
      for (let row = viewTop; row < viewBottom; row++) buffer.write(Math.floor(x), row, groundRows(Math.floor(width), 1, rowSampler(row)))
    } else if (boxBackgroundColor && y1 !== undefined && y2 !== undefined && (scrolled || !contentWas) && Math.floor(width) >= 1 && Math.floor(y2 - y1) >= 1) {
      buffer.write(Math.floor(x), Math.floor(y1), groundRows(Math.floor(width), Math.floor(y2 - y1), boxBackgroundColor))
    }
    const boxMoved = boxCached !== undefined && (boxCached.x !== x || boxCached.y !== y || boxCached.width !== width || boxCached.height !== height)
    composeScrolledChildren(content, walk, contentLeft, contentTop, hasRemovedChild, rowSampler !== undefined || scrolled || boxMoved ? undefined : prevScreen, paintTop, paintTop + innerHeight, boxBackgroundColor, false, rowSampler)
  }
  nodeCache.set(content, { x: contentLeft, y: contentTop, width: contentYoga.getComputedWidth(), height: contentYoga.getComputedHeight() })
  settle(content)
}

function repairStableRows(content: FrameNode, walk: Walk, dirtyChildren: Set<FrameNode['childNodes'][number]>, contentLeft: number, contentTop: number, delta: number, paintTop: number, innerHeight: number, incomingTop: number, incomingBottom: number, viewportFloor: number, left: number, columns: number, boxBackgroundColor: Color | undefined): void {
  const { buffer } = walk
  let cumulativeGrowth = 0
  for (const entry of content.childNodes) {
    const child = entry as FrameNode
    const isDirty = dirtyChildren.has(entry)
    const layout = child.layoutNode
    if ((!isDirty && cumulativeGrowth === 0 && nodeCache.has(child)) || !layout) continue
    const childTop = layout.getComputedTop()
    const childHeight = layout.getComputedHeight()
    const childBottom = childTop + childHeight
    if (isDirty) cumulativeGrowth += childHeight - (nodeCache.get(child)?.height ?? 0)
    const offscreen = childBottom <= paintTop || childTop >= paintTop + innerHeight
    const insideIncoming = childTop >= incomingTop - contentTop && childBottom <= incomingBottom + 1 - contentTop
    if (offscreen || insideIncoming) continue
    const screenTop = Math.floor(contentTop + childTop)
    const childWas = isDirty ? undefined : nodeCache.get(child)
    if (childWas && Math.floor(childWas.y) - delta === screenTop) continue
    const screenBottom = Math.min(Math.floor(contentTop + childBottom), viewportFloor)
    if (screenTop < screenBottom) {
      buffer.write(left, screenTop, groundRows(columns, screenBottom - screenTop, boxBackgroundColor))
      buffer.clip({ x1: undefined, x2: undefined, y1: screenTop, y2: screenBottom })
      composeNode(child, walk, { offsetX: contentLeft, offsetY: contentTop, prevScreen: undefined, inheritedBackgroundColor: boxBackgroundColor })
      buffer.unclip()
    }
  }
}

type ScreenOffer = 'open' | 'clipped' | 'closed'

function composeChildren(node: FrameNode, walk: Walk, offsetX: number, offsetY: number, hasRemovedChild: boolean, prevScreen: Screen | undefined, inheritedBackgroundColor: Color | undefined, inheritedRowBg?: RowGround): void {
  let offer: ScreenOffer = hasRemovedChild ? 'closed' : 'open'
  for (const child of node.childNodes as FrameNode[]) {
    const wasDirty = child.dirty
    const floating = child.style.position === 'absolute'
    const seeThrough = floating && !child.style.opaque && child.style.backgroundColor === undefined
    composeNode(child, walk, { offsetX, offsetY, prevScreen: offer === 'closed' ? undefined : prevScreen, skipSelfBlit: offer === 'clipped' && seeThrough, inheritedBackgroundColor, inheritedRowBg })
    if (wasDirty && offer !== 'closed') offer = !floating && clipsBothAxes(child) ? 'clipped' : 'closed'
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
    const floatingRect = elem.style.position === 'absolute' ? nodeCache.get(elem) : undefined
    if (floatingRect !== undefined) {
      walk.signals.absoluteRectsCur.push(floatingRect)
      restoreIfEscaping(walk, prevScreen, floatingRect, left, top, right, bottom)
    }
    pushElementChildren(pending, elem)
  }
}

type Band = { top: number; height: number; grewBy: number }

const measured: Band = { top: 0, height: 0, grewBy: 0 }

function measureScrolledChild(child: FrameNode, layout: LayoutNode, cached: CachedLayout | undefined, shiftAbove: number): Band {
  if (cached?.top !== undefined && !child.dirty && shiftAbove === 0) {
    measured.top = cached.top
    measured.height = cached.height
    measured.grewBy = 0
    return measured
  }
  measured.top = layout.getComputedTop()
  measured.height = layout.getComputedHeight()
  measured.grewBy = child.dirty ? measured.height - (cached?.height ?? 0) : 0
  if (cached) cached.top = measured.top
  return measured
}

const outsideBand = (band: Band, bandTop: number, bandBottom: number): boolean => band.top + band.height <= bandTop || band.top >= bandBottom

function composeScrolledChildren(node: FrameNode, walk: Walk, offsetX: number, offsetY: number, hasRemovedChild: boolean, prevScreen: Screen | undefined, scrollTopY: number, scrollBottomY: number, inheritedBackgroundColor: Color | undefined, preserveCulledCache = false, inheritedRowBg?: RowGround): void {
  let offerOpen = !hasRemovedChild
  let growthAbove = 0
  for (const child of node.childNodes as FrameNode[]) {
    const layout = child.layoutNode
    const band = layout ? measureScrolledChild(child, layout, nodeCache.get(child), growthAbove) : null
    if (band) growthAbove += band.grewBy
    const culled = band !== null && outsideBand(band, scrollTopY, scrollBottomY)
    if (culled && !preserveCulledCache) forgetSubtree(child)
    if (culled) continue
    const wasDirty = child.dirty
    composeNode(child, walk, { offsetX, offsetY, prevScreen: offerOpen ? prevScreen : undefined, inheritedBackgroundColor, inheritedRowBg })
    if (wasDirty) offerOpen = false
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
