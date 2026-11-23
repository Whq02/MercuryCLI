import chalk from 'chalk'
import cliBoxes, { type BoxStyle } from 'cli-boxes'
import { colorize } from './colorize.js'
import type ComposeBuffer from './compose-buffer.js'
import type { DOMElement } from './dom.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'

export type BorderStyle = keyof typeof cliBoxes | 'dashed' | BoxStyle

type BorderTextOptions = {
  readonly content: string
  readonly position: 'top' | 'bottom'
  readonly align: 'start' | 'end' | 'center'
  readonly offset?: number
}

const CUSTOM_BORDER_STYLES: Record<string, BoxStyle> = {
  dashed: {
    topLeft: ' ',
    top: '╌',
    topRight: ' ',
    right: '╎',
    bottomRight: ' ',
    bottom: '╌',
    bottomLeft: ' ',
    left: '╎',
  },
}

type Edge = {
  visible: boolean
  color: string | undefined
  dim: boolean
}

function resolveGlyphs(style: BorderStyle): BoxStyle | undefined {
  if (typeof style === 'object') return style
  return CUSTOM_BORDER_STYLES[style] ?? cliBoxes[style as keyof typeof cliBoxes]
}

function resolveGround(
  rowBg: ((row: number) => string | undefined) | undefined,
  row: number,
  effectiveGround: string | undefined,
): string | undefined {
  const sampled = rowBg ? rowBg(row) : undefined
  const bg = sampled !== undefined ? sampled : effectiveGround
  return bg && bg.length > 0 ? bg : undefined
}

function styleEdgeFg(segment: string, edge: Edge): string {
  if (segment === '') return ''
  let styled = colorize(segment, edge.color, 'foreground')
  if (edge.dim) styled = chalk.dim(styled)
  return styled
}

function styleEdge(segment: string, edge: Edge, bg: string | undefined): string {
  if (segment === '') return ''
  const styled = styleEdgeFg(segment, edge)
  return bg ? colorize(styled, bg, 'background') : styled
}

function renderHorizontal(
  plain: string,
  edge: Edge,
  bg: string | undefined,
  borderText: BorderTextOptions | undefined,
): string {
  if (plain === '') return ''
  if (!borderText) return styleEdge(plain, edge, bg)
  const availableWidth = plain.length
  const textWidth = stringWidth(borderText.content)
  let result: string
  if (textWidth >= availableWidth - 2) {
    result = sliceAnsi(borderText.content, 0, availableWidth)
  } else {
    const offset = borderText.offset ?? 0
    const maxPos = availableWidth - 1 - textWidth
    let insertPos: number
    if (borderText.align === 'start') {
      insertPos = 1 + offset
    } else if (borderText.align === 'end') {
      insertPos = availableWidth - 1 - textWidth - offset
    } else {
      insertPos = Math.floor((availableWidth - textWidth) / 2)
    }
    insertPos = Math.max(1, Math.min(insertPos, maxPos))
    const before = plain.slice(0, insertPos)
    const after = plain.slice(insertPos + textWidth)
    result = styleEdgeFg(before, edge) + borderText.content + styleEdgeFg(after, edge)
  }
  return bg && result !== '' ? colorize(result, bg, 'background') : result
}

function renderVertical(
  glyph: string,
  edge: Edge,
  startRow: number,
  verticalHeight: number,
  rowBg: ((row: number) => string | undefined) | undefined,
  effectiveGround: string | undefined,
): string {
  if (verticalHeight <= 0) return ''
  if (rowBg) {
    const lines: string[] = []
    for (let i = 0; i < verticalHeight; i++) {
      const bg = resolveGround(rowBg, startRow + i, effectiveGround)
      lines.push(styleEdge(glyph, edge, bg))
    }
    return lines.join('\n')
  }
  const bg = effectiveGround && effectiveGround.length > 0 ? effectiveGround : undefined
  const one = styleEdge(glyph, edge, bg)
  const lines: string[] = []
  for (let i = 0; i < verticalHeight; i++) lines.push(one)
  return lines.join('\n')
}

export default function renderBorder(
  x: number,
  y: number,
  node: DOMElement,
  output: ComposeBuffer,
  effectiveGround?: string,
): void {
  const { style, layoutNode } = node
  if (!style.borderStyle || !layoutNode) return
  const box = resolveGlyphs(style.borderStyle)
  if (!box) return

  const width = Math.floor(layoutNode.getComputedWidth())
  const height = Math.floor(layoutNode.getComputedHeight())

  const topEdge: Edge = {
    visible: style.borderTop !== false,
    color: style.borderTopColor ?? style.borderColor,
    dim: style.borderTopDimColor ?? style.borderDimColor ?? false,
  }
  const bottomEdge: Edge = {
    visible: style.borderBottom !== false,
    color: style.borderBottomColor ?? style.borderColor,
    dim: style.borderBottomDimColor ?? style.borderDimColor ?? false,
  }
  const leftEdge: Edge = {
    visible: style.borderLeft !== false,
    color: style.borderLeftColor ?? style.borderColor,
    dim: style.borderLeftDimColor ?? style.borderDimColor ?? false,
  }
  const rightEdge: Edge = {
    visible: style.borderRight !== false,
    color: style.borderRightColor ?? style.borderColor,
    dim: style.borderRightDimColor ?? style.borderDimColor ?? false,
  }

  const contentWidth = Math.max(0, width - (leftEdge.visible ? 1 : 0) - (rightEdge.visible ? 1 : 0))
  const verticalHeight = Math.max(0, height - (topEdge.visible ? 1 : 0) - (bottomEdge.visible ? 1 : 0))
  const offsetY = topEdge.visible ? 1 : 0
  const rowBg = style.borderRowBg
  const borderText: BorderTextOptions | undefined = style.borderText

  if (topEdge.visible) {
    const topPlain =
      (leftEdge.visible ? box.topLeft : '') +
      box.top.repeat(contentWidth) +
      (rightEdge.visible ? box.topRight : '')
    const topBg = resolveGround(rowBg, y, effectiveGround)
    const topBorder = renderHorizontal(
      topPlain,
      topEdge,
      topBg,
      borderText?.position === 'top' ? borderText : undefined,
    )
    if (topBorder !== '') output.write(x, y, topBorder)
  }

  if (leftEdge.visible && verticalHeight > 0) {
    const leftBorder = renderVertical(box.left, leftEdge, y + offsetY, verticalHeight, rowBg, effectiveGround)
    if (leftBorder !== '') output.write(x, y + offsetY, leftBorder)
  }

  if (rightEdge.visible && verticalHeight > 0) {
    const rightBorder = renderVertical(box.right, rightEdge, y + offsetY, verticalHeight, rowBg, effectiveGround)
    if (rightBorder !== '') output.write(x + width - 1, y + offsetY, rightBorder)
  }

  if (bottomEdge.visible) {
    const bottomPlain =
      (leftEdge.visible ? box.bottomLeft : '') +
      box.bottom.repeat(contentWidth) +
      (rightEdge.visible ? box.bottomRight : '')
    const bottomBg = resolveGround(rowBg, y + height - 1, effectiveGround)
    const bottomBorder = renderHorizontal(
      bottomPlain,
      bottomEdge,
      bottomBg,
      borderText?.position === 'bottom' ? borderText : undefined,
    )
    if (bottomBorder !== '') output.write(x, y + height - 1, bottomBorder)
  }
}
