import indentString from 'indent-string'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { applyTextStyles } from './colorize.js'
import { expandTabsWithColumn } from './tabstops.js'
import type { DOMElement } from './dom.js'
import getMaxWidth from './get-max-width.js'
import type { Rectangle } from './layout/geometry.js'
import { LayoutDisplay, LayoutEdge, type LayoutNode } from './layout/node.js'
import { nodeCache, pendingClears } from './node-cache.js'
import type ComposeBuffer from './compose-buffer.js'
import renderBorder from './render-border.js'
import type { Screen } from './cell-grid.js'
import squashTextNodes, {
  type StyledSegment,
  squashTextNodesToSegments,
} from './squash-text-nodes.js'
import type { Color } from './styles.js'
import { isXtermJs } from './session/capabilities.js'
import { widestLine } from './widest-line.js'
import wrapText, { truncateParts } from './wrap-text.js'


export type ScrollHint = { top: number; bottom: number; delta: number }
export type ScrollTranslation = {
  delta: number
  viewportTop: number
  viewportBottom: number
}

const SHIFT_LOG_CAP = 48
const shiftForensicsOn = !!process.env.INK_COMPOSED_TEE

export class ComposeSignals {
  layoutShifted = false
  private shiftMinRow: number | null = null
  private shiftRowUnknown = false
  shiftReason: string | null = null
  shiftLog: string[] = []
  scrollHint: ScrollHint | null = null
  scrollDrainNode: DOMElement | null = null
  scrollTranslation: ScrollTranslation | null = null
  readonly absoluteRectsCur: Rectangle[] = []

  markLayoutShift(reason: () => string, divergentRow?: number): void {
    if (shiftForensicsOn && this.shiftLog.length < SHIFT_LOG_CAP) {
      const r = reason()
      if (!this.layoutShifted) this.shiftReason = r
      this.shiftLog.push(r)
    }
    if (divergentRow === undefined || !Number.isFinite(divergentRow)) {
      this.shiftRowUnknown = true
    } else {
      this.shiftMinRow =
        this.shiftMinRow === null ? divergentRow : Math.min(this.shiftMinRow, divergentRow)
    }
    this.layoutShifted = true
  }

  shiftBandTop(): number | null {
    if (!this.layoutShifted || this.shiftRowUnknown || this.shiftMinRow === null) return null
    return Math.max(0, Math.floor(this.shiftMinRow))
  }

  consumeScrollTranslation(): ScrollTranslation | null {
    const t = this.scrollTranslation
    this.scrollTranslation = null
    return t
  }
}

export function expandDamageForAbsoluteRects(
  screen: { width: number; height: number; damage: Rectangle | undefined },
  prevRects: readonly Rectangle[],
  curRects: readonly Rectangle[],
): void {
  if (prevRects.length === 0 && curRects.length === 0) return
  for (const r of [...prevRects, ...curRects]) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(screen.width, Math.ceil(r.x + r.width))
    const y1 = Math.min(screen.height, Math.ceil(r.y + r.height))
    if (x1 <= x0 || y1 <= y0) continue
    const d = screen.damage
    if (!d) {
      screen.damage = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      continue
    }
    const right = Math.max(d.x + d.width, x1)
    const bottom = Math.max(d.y + d.height, y1)
    if (x0 < d.x) d.x = x0
    if (y0 < d.y) d.y = y0
    d.width = right - d.x
    d.height = bottom - d.y
  }
}


function isXtermJsHost(): boolean {
  return process.env.TERM_PROGRAM === 'vscode' || isXtermJs()
}

const SCROLL_MIN_PER_FRAME = 4
const SCROLL_INSTANT_THRESHOLD = 5
const SCROLL_HIGH_PENDING = 12
const SCROLL_STEP_MED = 2
const SCROLL_STEP_HIGH = 3
const SCROLL_MAX_PENDING = 30

function drainAdaptive(node: DOMElement, pending: number, innerHeight: number): number {
  const sign = pending > 0 ? 1 : -1
  let abs = Math.abs(pending)
  let applied = 0
  if (abs > SCROLL_MAX_PENDING) {
    applied += sign * (abs - SCROLL_MAX_PENDING)
    abs = SCROLL_MAX_PENDING
  }
  const step =
    abs <= SCROLL_INSTANT_THRESHOLD
      ? abs
      : abs < SCROLL_HIGH_PENDING
        ? SCROLL_STEP_MED
        : SCROLL_STEP_HIGH
  applied += sign * step
  const rem = abs - step
  const cap = Math.max(1, innerHeight - 1)
  const totalAbs = Math.abs(applied)
  if (totalAbs > cap) {
    const excess = totalAbs - cap
    ;(node.scroll ??= {}).pendingScrollDelta = sign * (rem + excess)
    return sign * cap
  }
  ;(node.scroll ??= {}).pendingScrollDelta = rem > 0 ? sign * rem : undefined
  return applied
}

function drainProportional(node: DOMElement, pending: number, innerHeight: number): number {
  const abs = Math.abs(pending)
  const cap = Math.max(1, innerHeight - 1)
  const step = Math.min(cap, Math.max(SCROLL_MIN_PER_FRAME, (abs * 3) >> 2))
  if (abs <= step) {
    ;(node.scroll ??= {}).pendingScrollDelta = undefined
    return pending
  }
  const applied = pending > 0 ? step : -step
  ;(node.scroll ??= {}).pendingScrollDelta = pending - applied
  return applied
}


const OSC = '\u001B]'
const BEL = '\u0007'

function wrapWithOsc8Link(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
}

export function buildCharToSegmentMap(segments: StyledSegment[]): number[] {
  const map: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i]!.text.length
    for (let j = 0; j < len; j++) map.push(i)
  }
  return map
}

const wrapperInputForm = (text: string): string => text.normalize('NFC').replace(/\r\n/g, '\n')

function wrapperNormalForm(
  segments: StyledSegment[],
  plainText: string,
): { plain: string; charToSegment: number[] } {
  const plain = wrapperInputForm(plainText)
  if (plain === plainText) return { plain, charToSegment: buildCharToSegmentMap(segments) }
  const charToSegment: number[] = []
  let through = ''
  for (let i = 0; i < segments.length; i++) {
    through += segments[i]!.text
    const upto = wrapperInputForm(through).length
    while (charToSegment.length < upto) charToSegment.push(i)
  }
  return { plain, charToSegment }
}

export function applyStylesToWrappedText(
  wrappedPlain: string,
  segments: StyledSegment[],
  charToSegment: number[],
  originalPlain: string,
  trimEnabled: boolean = false,
  softWrap?: readonly boolean[],
): string {
  const lines = wrappedPlain.split('\n')
  const resultLines: string[] = []

  let charIndex = 0
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!

    if (trimEnabled && line.length > 0) {
      const lineStartsWithWhitespace = /\s/.test(line[0]!)
      const originalHasWhitespace =
        charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)
      if (originalHasWhitespace && !lineStartsWithWhitespace) {
        while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
          charIndex++
        }
      }
    } else if (softWrap?.[lineIdx] === true && !line.startsWith(' ')) {
      while (charIndex < originalPlain.length && originalPlain[charIndex] === ' ') {
        charIndex++
      }
    }

    let styledLine = ''
    let runStart = 0
    let runSegmentIndex = charToSegment[charIndex] ?? 0

    const flushRun = (endExclusive: number): void => {
      const runText = line.slice(runStart, endExclusive)
      const segment = segments[runSegmentIndex]
      if (segment) {
        let styled = applyTextStyles(runText, segment.styles)
        if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
        styledLine += styled
      } else {
        styledLine += runText
      }
    }

    for (let i = 0; i < line.length; i++) {
      const currentSegmentIndex = charToSegment[charIndex] ?? runSegmentIndex
      if (currentSegmentIndex !== runSegmentIndex) {
        flushRun(i)
        runStart = i
        runSegmentIndex = currentSegmentIndex
      }
      charIndex++
    }
    flushRun(line.length)
    resultLines.push(styledLine)

    if (charIndex < originalPlain.length && originalPlain[charIndex] === '\n') {
      charIndex++
    }

    if (trimEnabled && lineIdx < lines.length - 1) {
      const nextLine = lines[lineIdx + 1]!
      const nextFirst = nextLine.length > 0 ? nextLine[0] : null
      while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
        if (nextFirst !== null && originalPlain[charIndex] === nextFirst) break
        charIndex++
      }
    }
  }

  return resultLines.join('\n')
}

function styleSourceRange(
  plainText: string,
  segments: StyledSegment[],
  charToSegment: number[],
  from: number,
  to: number,
): string {
  let out = ''
  let runStart = from
  let runSegment = charToSegment[from] ?? 0
  const flush = (end: number): void => {
    if (end <= runStart) return
    const runText = plainText.slice(runStart, end)
    const segment = segments[runSegment]
    if (segment) {
      let styled = applyTextStyles(runText, segment.styles)
      if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
      out += styled
    } else {
      out += runText
    }
  }
  for (let i = from; i < to; i++) {
    const seg = charToSegment[i] ?? runSegment
    if (seg !== runSegment) {
      flush(i)
      runStart = i
      runSegment = seg
    }
  }
  flush(to)
  return out
}

function styleTruncatedLines(
  plainText: string,
  segments: StyledSegment[],
  charToSegment: number[],
  maxWidth: number,
  textWrap: string,
): string {
  const out: string[] = []
  let base = 0
  for (const line of plainText.split('\n')) {
    const end = base + line.length
    const parts = truncateParts(line, maxWidth, textWrap)
    if (parts === null) {
      out.push(styleSourceRange(plainText, segments, charToSegment, base, end))
    } else {
      const leadEnd = base + parts.lead.length
      const trailStart = end - parts.trail.length
      let styled = styleSourceRange(plainText, segments, charToSegment, base, leadEnd)
      if (parts.ellipsis) {
        const cutAt = Math.max(base, Math.min(leadEnd, end - 1))
        const segment = segments[charToSegment[cutAt] ?? 0]
        styled += segment ? applyTextStyles('…', segment.styles) : '…'
      }
      styled += styleSourceRange(plainText, segments, charToSegment, trailStart, end)
      out.push(styled)
    }
    base = end + 1
  }
  return out.join('\n')
}

function wrapWithSoftWrap(
  plainText: string,
  maxWidth: number,
  textWrap: Parameters<typeof wrapText>[2],
): { wrapped: string; softWrap: boolean[] | undefined } {
  if (textWrap !== 'wrap' && textWrap !== 'wrap-trim') {
    if (!plainText.includes('\n')) {
      return { wrapped: wrapText(plainText, maxWidth, textWrap), softWrap: undefined }
    }
    return {
      wrapped: plainText
        .split('\n')
        .map(line => wrapText(line, maxWidth, textWrap))
        .join('\n'),
      softWrap: undefined,
    }
  }
  const outLines: string[] = []
  const softWrap: boolean[] = []
  for (const orig of plainText.split('\n')) {
    const pieces = wrapText(orig, maxWidth, textWrap).split('\n')
    for (let i = 0; i < pieces.length; i++) {
      outLines.push(pieces[i]!)
      softWrap.push(i > 0)
    }
  }
  return { wrapped: outLines.join('\n'), softWrap }
}

function applyPaddingToText(node: DOMElement, text: string, softWrap?: boolean[]): string {
  const layoutNode = node.childNodes[0]?.layoutNode
  if (layoutNode) {
    const offsetX = layoutNode.getComputedLeft()
    const offsetY = layoutNode.getComputedTop()
    text = '\n'.repeat(offsetY) + indentString(text, offsetX)
    if (softWrap && offsetY > 0) {
      softWrap.unshift(...Array<boolean>(offsetY).fill(false))
    }
  }
  return text
}


type WalkCtx = {
  buffer: ComposeBuffer
  signals: ComposeSignals
  prevAbsoluteRects: readonly Rectangle[]
  regionScrollUsable: boolean
}

type NodeOpts = {
  offsetX?: number
  offsetY?: number
  prevScreen: Screen | undefined
  skipSelfBlit?: boolean
  inheritedBackgroundColor?: Color
  inheritedRowBg?: (row: number) => Color | undefined
}

export type ComposeOptions = {
  offsetX?: number
  offsetY?: number
  prevScreen: Screen | undefined
  signals?: ComposeSignals
  prevAbsoluteRects?: readonly Rectangle[]
  regionScrollUsable?: boolean
}

export default function composeTree(
  root: DOMElement,
  buffer: ComposeBuffer,
  opts: ComposeOptions,
): ComposeSignals {
  const ctx: WalkCtx = {
    buffer,
    signals: opts.signals ?? new ComposeSignals(),
    prevAbsoluteRects: opts.prevAbsoluteRects ?? [],
    regionScrollUsable: opts.regionScrollUsable === true,
  }
  composeNode(root, ctx, {
    offsetX: opts.offsetX,
    offsetY: opts.offsetY,
    prevScreen: opts.prevScreen,
  })
  return ctx.signals
}

function composeNode(node: DOMElement, ctx: WalkCtx, opts: NodeOpts): void {
  const { layoutNode } = node
  if (!layoutNode) return
  const { buffer, signals } = ctx
  const offsetX = opts.offsetX ?? 0
  const offsetY = opts.offsetY ?? 0

  if (layoutNode.getDisplay() === LayoutDisplay.None) {
    if (node.dirty) {
      const cached = nodeCache.get(node)
      if (cached) {
        buffer.clear({
          x: Math.floor(cached.x),
          y: Math.floor(cached.y),
          width: Math.floor(cached.width),
          height: Math.floor(cached.height),
        })
        dropSubtreeCache(node)
        signals.markLayoutShift(() => `display-none-clear:${node.nodeName}`, Math.floor(cached.y))
      }
    }
    return
  }

  const x = offsetX + layoutNode.getComputedLeft()
  const yogaTop = layoutNode.getComputedTop()
  let y = offsetY + yogaTop
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()

  if (y < 0 && node.style.position === 'absolute') {
    y = 0
  }

  const cached = nodeCache.get(node)
  if (
    !node.dirty &&
    !opts.skipSelfBlit &&
    node.scroll?.pendingScrollDelta === undefined &&
    cached &&
    cached.x === x &&
    cached.y === y &&
    cached.width === width &&
    cached.height === height &&
    opts.prevScreen
  ) {
    const fx = Math.floor(x)
    const fy = Math.floor(y)
    const fw = Math.floor(width)
    const fh = Math.floor(height)
    buffer.blit(opts.prevScreen, fx, fy, fw, fh)
    if (node.style.position === 'absolute') {
      signals.absoluteRectsCur.push(cached)
    }
    blitEscapingAbsoluteDescendants(node, ctx, opts.prevScreen, fx, fy, fw, fh)
    return
  }

  const positionChanged =
    cached !== undefined &&
    (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height)
  if (positionChanged) {
    signals.markLayoutShift(
      () => {
        const s = node.style as Record<string, unknown>
        const fp =
          ` w=${JSON.stringify(s['width'])},mw=${JSON.stringify(s['minWidth'])}` +
          `,fg=${JSON.stringify(s['flexGrow'])},fs=${JSON.stringify(s['flexShrink'])}` +
          `,fb=${JSON.stringify(s['flexBasis'])},as=${JSON.stringify(s['alignSelf'])}`
        let text = ''
        if (node.nodeName === 'ink-text') {
          try {
            text = ` "${squashTextNodes(node).replace(/\n/g, '\\n').slice(0, 28)}"`
          } catch {
          }
        }
        return (
          `moved:${node.nodeName}@${Math.floor(x)},${Math.floor(y)} ` +
          `${cached!.x},${cached!.y},${cached!.width}x${cached!.height}→${x},${y},${width}x${height}` +
          fp +
          text +
          (node.debugOwnerChain ? ` [${node.debugOwnerChain.slice(0, 5).join('<')}]` : '')
        )
      },
      cached!.y !== y
        ? Math.floor(Math.min(cached!.y, y))
        : cached!.height !== height
          ? Math.floor(y + Math.min(cached!.height, height))
          : Math.floor(y),
    )
  }
  if (cached && (node.dirty || positionChanged)) {
    buffer.clear(
      {
        x: Math.floor(cached.x),
        y: Math.floor(cached.y),
        width: Math.floor(cached.width),
        height: Math.floor(cached.height),
      },
      node.style.position === 'absolute',
    )
  }

  const clears = pendingClears.get(node)
  const hasRemovedChild = clears !== undefined
  if (hasRemovedChild) {
    signals.markLayoutShift(
      () => `removed-child:${node.nodeName}`,
      clears!.length > 0 ? Math.min(...clears!.map(r => Math.floor(r.y))) : undefined,
    )
    for (const rect of clears!) {
      buffer.clear({
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      })
    }
    pendingClears.delete(node)
  }

  if (height === 0 && siblingSharesY(node, layoutNode)) {
    nodeCache.set(node, { x, y, width, height, top: yogaTop })
    dropSubtreeCache(node)
    node.dirty = false
    return
  }

  if (node.nodeName === 'ink-raw-ansi') {
    const text = node.attributes['rawText'] as string
    if (text) buffer.write(x, y, text)
  } else if (node.nodeName === 'ink-text') {
    composeText(node, ctx, x, y, layoutNode, opts.inheritedBackgroundColor, opts.inheritedRowBg)
  } else if (node.nodeName === 'ink-box') {
    composeBox(node, ctx, opts, x, y, yogaTop, width, height, layoutNode, hasRemovedChild)
  } else if (node.nodeName === 'ink-root') {
    composeChildren(node, ctx, x, y, hasRemovedChild, opts.prevScreen, opts.inheritedBackgroundColor, opts.inheritedRowBg)
  }

  const rect = { x, y, width, height, top: yogaTop }
  nodeCache.set(node, rect)
  if (node.style.position === 'absolute') {
    signals.absoluteRectsCur.push(rect)
  }
  node.dirty = false
}


function composeText(
  node: DOMElement,
  ctx: WalkCtx,
  x: number,
  y: number,
  layoutNode: LayoutNode,
  inheritedBackgroundColor: Color | undefined,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let segments = squashTextNodesToSegments(
    node,
    inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined,
  )
  if (segments.some(s => s.text.includes('\t'))) {
    let column = 0
    segments = segments.map(s => {
      const expanded = expandTabsWithColumn(s.text, column)
      column = expanded.column
      return expanded.text === s.text ? s : { ...s, text: expanded.text }
    })
  }
  const plainText = segments.map(s => s.text).join('')
  if (plainText.length === 0) return

  const maxWidth = Math.min(getMaxWidth(layoutNode), ctx.buffer.width - x)
  const textWrap = node.style.textWrap ?? 'wrap'
  const needsWrapping = widestLine(plainText) > maxWidth

  let text: string
  let softWrap: boolean[] | undefined
  if (needsWrapping && segments.length === 1) {
    const segment = segments[0]!
    const w = wrapWithSoftWrap(plainText, maxWidth, textWrap)
    softWrap = w.softWrap
    text = w.wrapped
      .split('\n')
      .map(line => {
        let styled = applyTextStyles(line, segment.styles)
        if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
        return styled
      })
      .join('\n')
  } else if (needsWrapping && textWrap.startsWith('truncate')) {
    softWrap = undefined
    text = styleTruncatedLines(plainText, segments, buildCharToSegmentMap(segments), maxWidth, textWrap)
  } else if (needsWrapping) {
    const wraps = textWrap === 'wrap' || textWrap === 'wrap-trim'
    const { plain, charToSegment } = wraps
      ? wrapperNormalForm(segments, plainText)
      : { plain: plainText, charToSegment: buildCharToSegmentMap(segments) }
    const w = wrapWithSoftWrap(plain, maxWidth, textWrap)
    softWrap = w.softWrap
    text = applyStylesToWrappedText(
      w.wrapped,
      segments,
      charToSegment,
      plain,
      textWrap === 'wrap-trim',
      textWrap === 'wrap' ? softWrap : undefined,
    )
  } else {
    text = segments
      .map(segment => {
        let styledText = applyTextStyles(segment.text, segment.styles)
        if (segment.hyperlink) styledText = wrapWithOsc8Link(styledText, segment.hyperlink)
        return styledText
      })
      .join('')
  }

  text = applyPaddingToText(node, text, softWrap)
  if (inheritedRowBg !== undefined && inheritedBackgroundColor === undefined) {
    text = text
      .split('\n')
      .map((line, k) => {
        const bg = inheritedRowBg(y + k)
        return bg !== undefined && line.length > 0 ? applyTextStyles(line, { backgroundColor: bg }) : line
      })
      .join('\n')
  }
  ctx.buffer.write(x, y, text, softWrap)
}


function groundFillLines(width: number, height: number, bg: Color | undefined): string {
  const spaces = ' '.repeat(width)
  const line = bg ? applyTextStyles(spaces, { backgroundColor: bg }) : spaces
  return Array(height).fill(line).join('\n')
}

function composeBox(
  node: DOMElement,
  ctx: WalkCtx,
  opts: NodeOpts,
  x: number,
  y: number,
  yogaTop: number,
  width: number,
  height: number,
  layoutNode: LayoutNode,
  hasRemovedChild: boolean,
): void {
  const { buffer, signals } = ctx
  const ownRowBg = node.style.fillRowBg
  const rowSampler =
    node.style.backgroundColor !== undefined
      ? undefined
      : ((ownRowBg as ((row: number) => Color | undefined) | undefined) ?? opts.inheritedRowBg)
  const boxBackgroundColor =
    node.style.backgroundColor ?? (rowSampler !== undefined ? undefined : opts.inheritedBackgroundColor)

  if (node.style.noSelect) {
    const boxX = Math.floor(x)
    const fromEdge = node.style.noSelect === 'from-left-edge'
    buffer.noSelect({
      x: fromEdge ? 0 : boxX,
      y: Math.floor(y),
      width: fromEdge ? boxX + Math.floor(width) : Math.floor(width),
      height: Math.floor(height),
    })
  }

  const overflowX = node.style.overflowX ?? node.style.overflow
  const overflowY = node.style.overflowY ?? node.style.overflow
  const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll'
  const clipVertically = overflowY === 'hidden' || overflowY === 'scroll'
  const isScrollY = overflowY === 'scroll'
  const needsClip = clipHorizontally || clipVertically

  let y1: number | undefined
  let y2: number | undefined
  if (needsClip) {
    const x1 = clipHorizontally ? x + layoutNode.getComputedBorder(LayoutEdge.Left) : undefined
    const x2 = clipHorizontally
      ? x + layoutNode.getComputedWidth() - layoutNode.getComputedBorder(LayoutEdge.Right)
      : undefined
    y1 = clipVertically ? y + layoutNode.getComputedBorder(LayoutEdge.Top) : undefined
    y2 = clipVertically
      ? y + layoutNode.getComputedHeight() - layoutNode.getComputedBorder(LayoutEdge.Bottom)
      : undefined
    buffer.clip({ x1, x2, y1, y2 })
  }

  if (isScrollY) {
    composeScrollBox(node, ctx, opts, x, y, width, height, layoutNode, y1, y2, hasRemovedChild, boxBackgroundColor, rowSampler)
  } else {
    const ownBackgroundColor = node.style.backgroundColor
    const fillMemo = node as unknown as { __prevOwnBg?: unknown; __prevOpaque?: boolean; __prevOwnRowBg?: boolean }
    const fillRemoved =
      (fillMemo.__prevOwnBg !== undefined && ownBackgroundColor === undefined) ||
      (fillMemo.__prevOpaque === true && node.style.opaque !== true) ||
      (fillMemo.__prevOwnRowBg === true && ownRowBg === undefined)
    fillMemo.__prevOwnBg = ownBackgroundColor
    fillMemo.__prevOpaque = node.style.opaque === true
    fillMemo.__prevOwnRowBg = ownRowBg !== undefined
    if (ownBackgroundColor || node.style.opaque || ownRowBg !== undefined || fillRemoved) {
      const borderLeft = layoutNode.getComputedBorder(LayoutEdge.Left)
      const borderRight = layoutNode.getComputedBorder(LayoutEdge.Right)
      const borderTop = layoutNode.getComputedBorder(LayoutEdge.Top)
      const borderBottom = layoutNode.getComputedBorder(LayoutEdge.Bottom)
      const innerWidth = Math.floor(width) - borderLeft - borderRight
      const innerHeight = Math.floor(height) - borderTop - borderBottom
      if (innerWidth > 0 && innerHeight > 0) {
        const uniformFillBg = ownBackgroundColor ?? (rowSampler !== undefined ? undefined : opts.inheritedBackgroundColor)
        if (uniformFillBg === undefined && rowSampler !== undefined) {
          const rowTop = y + borderTop
          for (let r = 0; r < innerHeight; r++) {
            buffer.write(x + borderLeft, rowTop + r, groundFillLines(innerWidth, 1, rowSampler(rowTop + r)))
          }
        } else {
          buffer.write(x + borderLeft, y + borderTop, groundFillLines(innerWidth, innerHeight, uniformFillBg))
        }
      }
    }

    composeChildren(
      node,
      ctx,
      x,
      y,
      hasRemovedChild,
      ownBackgroundColor || node.style.opaque || ownRowBg !== undefined || fillRemoved ? undefined : opts.prevScreen,
      boxBackgroundColor,
      rowSampler,
    )
  }

  if (needsClip) buffer.unclip()

  renderBorder(x, y, node, buffer as never, boxBackgroundColor)
  void signals
}


function composeScrollBox(
  node: DOMElement,
  ctx: WalkCtx,
  opts: NodeOpts,
  x: number,
  y: number,
  width: number,
  height: number,
  layoutNode: LayoutNode,
  y1: number | undefined,
  y2: number | undefined,
  hasRemovedChild: boolean,
  boxBackgroundColor: Color | undefined,
  rowSampler?: (row: number) => Color | undefined,
): void {
  const { buffer, signals } = ctx
  const prevScreen = opts.prevScreen
  const cached = nodeCache.get(node)

  const padTop = layoutNode.getComputedPadding(LayoutEdge.Top)
  const innerHeight = Math.max(
    0,
    (y2 ?? y + height) - (y1 ?? y) - padTop - layoutNode.getComputedPadding(LayoutEdge.Bottom),
  )

  const content = node.childNodes.find(c => (c as DOMElement).layoutNode) as DOMElement | undefined
  const contentYoga = content?.layoutNode
  const sc = (node.scroll ??= {})
  const scrollHeight = contentYoga?.getComputedHeight() ?? 0
  const prevScrollHeight = sc.scrollHeight ?? scrollHeight
  const prevInnerHeight = sc.scrollViewportHeight ?? innerHeight
  sc.scrollHeight = scrollHeight
  sc.scrollViewportHeight = innerHeight
  sc.scrollViewportTop = (y1 ?? y) + padTop

  const maxScroll = Math.max(0, scrollHeight - innerHeight)
  fluxMark('scroll:compose', scrollHeight * 100000 + (sc.scrollTop ?? 0))

  const contentRoot = node.childNodes[0]
  const anchorElTop = (start: DOMElement): number | undefined => {
    let el: DOMElement | undefined = start
    let acc = 0
    let hops = 0
    while (el && el !== node && el !== contentRoot && hops < 100) {
      const t = el.layoutNode?.getComputedTop()
      if (t == null) return undefined
      acc += t
      el = el.parentNode ?? undefined
      hops++
    }
    return el === contentRoot && Number.isFinite(acc) ? acc : undefined
  }

  if (sc.scrollAnchor) {
    const anchorTop = anchorElTop(sc.scrollAnchor.el)
    if (anchorTop != null) {
      sc.scrollTop = anchorTop + sc.scrollAnchor.offset
      sc.pendingScrollDelta = undefined
    }
    sc.scrollAnchor = undefined
  }


  const scrollTopBeforeFollow = sc.scrollTop ?? 0
  const sticky = sc.stickyScroll ?? Boolean(node.attributes['stickyScroll'])
  const prevMaxScroll = Math.max(0, prevScrollHeight - prevInnerHeight)
  const grew = scrollHeight >= prevScrollHeight
  const atBottom =
    sticky ||
    (grew && scrollTopBeforeFollow >= prevMaxScroll && sc.lastStableAtBottom !== false)
  if (atBottom && (sc.pendingScrollDelta ?? 0) >= 0) {
    sc.scrollTop = maxScroll
    sc.pendingScrollDelta = undefined
    if (
      sc.stickyScroll === false &&
      scrollTopBeforeFollow >= prevMaxScroll &&
      sc.lastStableAtBottom !== false
    ) {
      sc.stickyScroll = true
      fluxMark('scroll:restick', innerHeight)
    }
  }

  let cur = sc.scrollTop ?? 0
  const pending = sc.pendingScrollDelta
  const cMin = sc.scrollClampMin
  const cMax = sc.scrollClampMax
  const haveClamp = cMin !== undefined && cMax !== undefined
  if (pending !== undefined && pending !== 0) {
    const pastClamp = haveClamp && ((pending < 0 && cur < cMin) || (pending > 0 && cur > cMax))
    const eff = pastClamp ? Math.min(4, innerHeight >> 3) : innerHeight
    cur += isXtermJsHost() ? drainAdaptive(node, pending, eff) : drainProportional(node, pending, eff)
  } else if (pending === 0) {
    sc.pendingScrollDelta = undefined
  }
  let scrollTop = Math.max(0, Math.min(cur, maxScroll))
  const shrankPastPosition = scrollHeight < prevScrollHeight && cur > maxScroll
  const clamped = haveClamp ? Math.max(cMin, Math.min(scrollTop, cMax)) : scrollTop
  sc.scrollTop = shrankPastPosition ? Math.max(0, cur) : scrollTop
  if (grew && maxScroll > 0) {
    const nowAtBottom = scrollTop >= maxScroll
    if (nowAtBottom !== sc.lastStableAtBottom) fluxMark('scroll:bit', nowAtBottom ? 1 : 0)
    sc.lastStableAtBottom = nowAtBottom
  }
  if (scrollTop !== cur) sc.pendingScrollDelta = undefined
  const clampGap = clamped - scrollTop
  if (
    sc.pendingScrollDelta !== undefined ||
    (clampGap !== 0 && clampGap !== (sc.scrollClampGapPrev ?? 0))
  ) {
    signals.scrollDrainNode = node
  }
  sc.scrollClampGapPrev = clampGap
  scrollTop = clamped

  if (!content || !contentYoga) return

  const contentX = x + contentYoga.getComputedLeft()
  const contentY = y + contentYoga.getComputedTop() - scrollTop

  const contentCached = nodeCache.get(content)
  let hint: ScrollHint | null = null
  let rectShift: { top: number; bottom: number; delta: number; x0: number; x1: number } | null =
    null
  if (contentCached && contentCached.y !== contentY) {
    const delta = contentCached.y - contentY
    const regionTop = Math.floor(y + contentYoga.getComputedTop())
    const regionBottom = regionTop + innerHeight - 1
    signals.scrollTranslation = { delta, viewportTop: regionTop, viewportBottom: regionBottom }
    if (delta > 0) fluxMark('scroll:follow', innerHeight)
    fluxMark('scroll:xlate', regionTop * 1000 + delta + 500)
    if (rowSampler === undefined) {
      const spansFullWidth = Math.floor(x) <= 0 && Math.ceil(x + width) >= buffer.width
      const stableForShift =
        cached?.y === y && cached.height === height && innerHeight > 0 && Math.abs(delta) < innerHeight
      if (stableForShift && spansFullWidth && ctx.regionScrollUsable) {
        hint = { top: regionTop, bottom: regionBottom, delta }
        signals.scrollHint = hint
      } else if (stableForShift) {
        rectShift = {
          top: regionTop,
          bottom: regionBottom,
          delta,
          x0: Math.floor(x),
          x1: Math.floor(x) + Math.floor(width),
        }
      } else {
        signals.markLayoutShift(() => `scroll-no-hint:${node.nodeName}`)
      }
    }
  }

  const prevHeight = contentCached?.height ?? scrollHeight
  const heightDelta = scrollHeight - prevHeight
  const shiftPlan = hint ?? rectShift
  const safeForFastPath =
    !shiftPlan || heightDelta === 0 || (shiftPlan.delta > 0 && heightDelta === shiftPlan.delta)
  if (!safeForFastPath) {
    signals.scrollHint = null
    if (rectShift) {
      rectShift = null
      signals.markLayoutShift(() => `scroll-rect-unsafe:${node.nodeName}`)
    }
  }

  if ((hint || rectShift) && prevScreen && safeForFastPath) {
    const { top, bottom, delta } = (hint ?? rectShift)!
    const w = Math.floor(width)
    buffer.blit(prevScreen, Math.floor(x), top, w, bottom - top + 1)
    if (hint) buffer.shift(top, bottom, delta)
    else buffer.shiftRect(top, bottom, rectShift!.x0, rectShift!.x1, delta)
    const edgeTop = delta > 0 ? bottom - delta + 1 : top
    const edgeBottom = delta > 0 ? bottom : top - delta - 1
    buffer.clear({ x: Math.floor(x), y: edgeTop, width: w, height: edgeBottom - edgeTop + 1 })
    if (boxBackgroundColor && edgeBottom >= edgeTop) {
      buffer.write(Math.floor(x), edgeTop, groundFillLines(w, edgeBottom - edgeTop + 1, boxBackgroundColor))
    }
    buffer.clip({ x1: undefined, x2: undefined, y1: edgeTop, y2: edgeBottom + 1 })
    const dirtyChildren = content.dirty
      ? new Set(content.childNodes.filter(c => (c as DOMElement).dirty))
      : null
    composeScrolledChildren(
      content,
      ctx,
      contentX,
      contentY,
      hasRemovedChild,
      undefined,
      edgeTop - contentY,
      edgeBottom + 1 - contentY,
      boxBackgroundColor,
      true,
    )
    buffer.unclip()

    if (dirtyChildren) {
      const edgeTopLocal = edgeTop - contentY
      const edgeBottomLocal = edgeBottom + 1 - contentY
      let cumHeightShift = 0
      for (const childNode of content.childNodes) {
        const childElem = childNode as DOMElement
        const isDirty = dirtyChildren.has(childNode)
        if (!isDirty && cumHeightShift === 0) {
          if (nodeCache.has(childElem)) continue
        }
        const cy = childElem.layoutNode
        if (!cy) continue
        const childTop = cy.getComputedTop()
        const childH = cy.getComputedHeight()
        const childBottom = childTop + childH
        if (isDirty) {
          const prev = nodeCache.get(childElem)
          cumHeightShift += childH - (prev ? prev.height : 0)
        }
        if (childBottom <= scrollTop || childTop >= scrollTop + innerHeight) continue
        if (childTop >= edgeTopLocal && childBottom <= edgeBottomLocal) continue
        const screenY = Math.floor(contentY + childTop)
        if (!isDirty) {
          const childCached = nodeCache.get(childElem)
          if (childCached && Math.floor(childCached.y) - delta === screenY) continue
        }
        const screenBottom = Math.min(
          Math.floor(contentY + childBottom),
          Math.floor((y1 ?? y) + padTop + innerHeight),
        )
        if (screenY < screenBottom) {
          buffer.write(Math.floor(x), screenY, groundFillLines(w, screenBottom - screenY, boxBackgroundColor))
          buffer.clip({ x1: undefined, x2: undefined, y1: screenY, y2: screenBottom })
          composeNode(childElem, ctx, {
            offsetX: contentX,
            offsetY: contentY,
            prevScreen: undefined,
            inheritedBackgroundColor: boxBackgroundColor,
          })
          buffer.unclip()
        }
      }
    }

    for (const r of ctx.prevAbsoluteRects) {
      if (r.y >= bottom + 1 || r.y + r.height <= top) continue
      const shiftedTop = Math.max(top, Math.floor(r.y) - delta)
      const shiftedBottom = Math.min(bottom + 1, Math.floor(r.y + r.height) - delta)
      if (shiftedTop >= edgeTop && shiftedBottom <= edgeBottom + 1) continue
      if (shiftedTop >= shiftedBottom) continue
      buffer.write(Math.floor(x), shiftedTop, groundFillLines(w, shiftedBottom - shiftedTop, boxBackgroundColor))
      buffer.clip({ x1: undefined, x2: undefined, y1: shiftedTop, y2: shiftedBottom })
      composeScrolledChildren(
        content,
        ctx,
        contentX,
        contentY,
        hasRemovedChild,
        undefined,
        shiftedTop - contentY,
        shiftedBottom - contentY,
        boxBackgroundColor,
        true,
      )
      buffer.unclip()
    }
  } else {
    const scrolled = contentCached && contentCached.y !== contentY
    if (scrolled && y1 !== undefined && y2 !== undefined) {
      buffer.clear({
        x: Math.floor(x),
        y: Math.floor(y1),
        width: Math.floor(width),
        height: Math.floor(y2 - y1),
      })
    }
    if (rowSampler !== undefined && y1 !== undefined && y2 !== undefined && Math.floor(width) >= 1) {
      const vy0 = Math.floor(y1)
      const vy1 = Math.floor(y2)
      for (let r = vy0; r < vy1; r++) {
        buffer.write(Math.floor(x), r, groundFillLines(Math.floor(width), 1, rowSampler(r)))
      }
    } else if (
      boxBackgroundColor &&
      y1 !== undefined &&
      y2 !== undefined &&
      (scrolled || !contentCached) &&
      Math.floor(width) >= 1 &&
      Math.floor(y2 - y1) >= 1
    ) {
      buffer.write(
        Math.floor(x),
        Math.floor(y1),
        groundFillLines(Math.floor(width), Math.floor(y2 - y1), boxBackgroundColor),
      )
    }
    const positionChanged =
      cached !== undefined &&
      (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height)
    composeScrolledChildren(
      content,
      ctx,
      contentX,
      contentY,
      hasRemovedChild,
      rowSampler !== undefined || scrolled || positionChanged ? undefined : prevScreen,
      scrollTop,
      scrollTop + innerHeight,
      boxBackgroundColor,
      false,
      rowSampler,
    )
  }
  nodeCache.set(content, {
    x: contentX,
    y: contentY,
    width: contentYoga.getComputedWidth(),
    height: contentYoga.getComputedHeight(),
  })
  content.dirty = false
}


function composeChildren(
  node: DOMElement,
  ctx: WalkCtx,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  inheritedBackgroundColor: Color | undefined,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let seenDirtyChild = false
  let seenDirtyClipped = false
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    const wasDirty = childElem.dirty
    const isAbsolute = childElem.style.position === 'absolute'
    composeNode(childElem, ctx, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      skipSelfBlit:
        seenDirtyClipped &&
        isAbsolute &&
        !childElem.style.opaque &&
        childElem.style.backgroundColor === undefined,
      inheritedBackgroundColor,
      inheritedRowBg,
    })
    if (wasDirty && !seenDirtyChild) {
      if (!clipsBothAxes(childElem) || isAbsolute) {
        seenDirtyChild = true
      } else {
        seenDirtyClipped = true
      }
    }
  }
}

function clipsBothAxes(node: DOMElement): boolean {
  const ox = node.style.overflowX ?? node.style.overflow
  const oy = node.style.overflowY ?? node.style.overflow
  return (ox === 'hidden' || ox === 'scroll') && (oy === 'hidden' || oy === 'scroll')
}

function siblingSharesY(node: DOMElement, layoutNode: LayoutNode): boolean {
  const parent = node.parentNode
  if (!parent) return false
  const myTop = layoutNode.getComputedTop()
  const siblings = parent.childNodes
  const idx = siblings.indexOf(node)
  for (let i = idx + 1; i < siblings.length; i++) {
    const sib = (siblings[i] as DOMElement).layoutNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  for (let i = idx - 1; i >= 0; i--) {
    const sib = (siblings[i] as DOMElement).layoutNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  return false
}

function blitEscapingAbsoluteDescendants(
  node: DOMElement,
  ctx: WalkCtx,
  prevScreen: Screen,
  px: number,
  py: number,
  pw: number,
  ph: number,
): void {
  const pr = px + pw
  const pb = py + ph
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const elem = child as DOMElement
    if (elem.style.position === 'absolute') {
      const cached = nodeCache.get(elem)
      if (cached) {
        ctx.signals.absoluteRectsCur.push(cached)
        const cx = Math.floor(cached.x)
        const cy = Math.floor(cached.y)
        const cw = Math.floor(cached.width)
        const ch = Math.floor(cached.height)
        if (cx < px || cy < py || cx + cw > pr || cy + ch > pb) {
          ctx.buffer.blit(prevScreen, cx, cy, cw, ch)
        }
      }
    }
    blitEscapingAbsoluteDescendants(elem, ctx, prevScreen, px, py, pw, ph)
  }
}

function composeScrolledChildren(
  node: DOMElement,
  ctx: WalkCtx,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  scrollTopY: number,
  scrollBottomY: number,
  inheritedBackgroundColor: Color | undefined,
  preserveCulledCache = false,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let seenDirtyChild = false
  let cumHeightShift = 0
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    const cy = childElem.layoutNode
    if (cy) {
      const cached = nodeCache.get(childElem)
      let top: number
      let height: number
      if (cached?.top !== undefined && !childElem.dirty && cumHeightShift === 0) {
        top = cached.top
        height = cached.height
      } else {
        top = cy.getComputedTop()
        height = cy.getComputedHeight()
        if (childElem.dirty) {
          cumHeightShift += height - (cached ? cached.height : 0)
        }
        if (cached) cached.top = top
      }
      const bottom = top + height
      if (bottom <= scrollTopY || top >= scrollBottomY) {
        if (!preserveCulledCache) dropSubtreeCache(childElem)
        continue
      }
    }
    const wasDirty = childElem.dirty
    composeNode(childElem, ctx, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      inheritedBackgroundColor,
      inheritedRowBg,
    })
    if (wasDirty) seenDirtyChild = true
  }
}

function dropSubtreeCache(node: DOMElement): void {
  nodeCache.delete(node)
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      dropSubtreeCache(child as DOMElement)
    }
  }
}
