// Border painting: per-edge visibility/colour/dim, the embedded title, and
// the row-addressed ground. With no ground the emitted bytes stay
// byte-identical to a foreground-only line — a hard compatibility
// requirement for flat and reduced-colour palettes.

import chalk from 'chalk'
import cliBoxes, { type BoxStyle } from 'cli-boxes'
import { colorize } from './colorize.js'
import type ComposeBuffer from './compose-buffer.js'
import type { DOMElement } from './dom.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'

export type BorderTextOptions = {
  content: string
  position: 'top' | 'bottom'
  align: 'start' | 'end' | 'center'
  offset?: number
}

export type BorderStyle = keyof typeof cliBoxes | 'dashed' | BoxStyle

// A custom name shadows a catalogue name of the same spelling. The corners
// are SPACES because no dashed line-drawing corners exist.
export const CUSTOM_BORDER_STYLES: Record<string, BoxStyle> = {
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

export default function renderBorder(
  x: number,
  y: number,
  node: DOMElement,
  output: ComposeBuffer,
  effectiveGround?: string,
): void {
  const style = node.style
  if (!style.borderStyle || !node.layoutNode) return
  const glyphs = resolveGlyphs(style.borderStyle)
  if (!glyphs) return

  const width = Math.floor(node.layoutNode.getComputedWidth())
  const height = Math.floor(node.layoutNode.getComputedHeight())

  const top: Edge = {
    visible: style.borderTop !== false,
    color: style.borderTopColor ?? style.borderColor,
    dim: style.borderTopDimColor ?? style.borderDimColor ?? false,
  }
  const bottom: Edge = {
    visible: style.borderBottom !== false,
    color: style.borderBottomColor ?? style.borderColor,
    dim: style.borderBottomDimColor ?? style.borderDimColor ?? false,
  }
  const left: Edge = {
    visible: style.borderLeft !== false,
    color: style.borderLeftColor ?? style.borderColor,
    dim: style.borderLeftDimColor ?? style.borderDimColor ?? false,
  }
  const right: Edge = {
    visible: style.borderRight !== false,
    color: style.borderRightColor ?? style.borderColor,
    dim: style.borderRightDimColor ?? style.borderDimColor ?? false,
  }

  const contentWidth =
    width - (left.visible ? 1 : 0) - (right.visible ? 1 : 0)

  const groundAt = (absoluteRow: number): string | undefined =>
    style.borderRowBg?.(absoluteRow) ?? effectiveGround

  // Edge colour, then dim, then — only when a ground exists — the
  // background OUTERMOST.
  const styleRun = (
    run: string,
    edge: Edge,
    ground: string | undefined,
  ): string => {
    let out = colorize(run, edge.color, 'foreground')
    if (edge.dim) out = chalk.dim(out)
    if (ground) out = colorize(out, ground, 'background')
    return out
  }

  const horizontalLine = (
    edge: Edge,
    glyph: string,
    leftCorner: string,
    rightCorner: string,
    absoluteRow: number,
    titled: boolean,
  ): string => {
    const line =
      (left.visible ? leftCorner : '') +
      glyph.repeat(Math.max(0, contentWidth)) +
      (right.visible ? rightCorner : '')
    const ground = groundAt(absoluteRow)
    const title = style.borderText
    if (titled && title) {
      return embedTitle(line, glyph, title, edge, ground)
    }
    return styleRun(line, edge, ground)
  }

  const embedTitle = (
    line: string,
    glyph: string,
    title: BorderTextOptions,
    edge: Edge,
    ground: string | undefined,
  ): string => {
    const titleWidth = stringWidth(title.content)
    const lineLength = line.length
    if (titleWidth >= lineLength - 2) {
      // The title takes the whole line, cut to the line length.
      let cut = sliceAnsi(title.content, 0, lineLength)
      if (ground) cut = colorize(cut, ground, 'background')
      return cut
    }
    const offset = title.offset ?? 0
    let insertion: number
    if (title.align === 'center') {
      insertion = Math.floor((lineLength - titleWidth) / 2)
    } else if (title.align === 'start') {
      insertion = offset + 1
    } else {
      insertion = lineLength - titleWidth - offset - 1
    }
    insertion = Math.max(1, Math.min(insertion, lineLength - titleWidth - 1))
    const leadGlyphs = line[0]! + glyph.repeat(Math.max(0, insertion - 1))
    const tailCount = Math.max(0, lineLength - insertion - titleWidth - 1)
    const tailGlyphs = glyph.repeat(tailCount) + line[lineLength - 1]!
    // Border segments take the edge styling; the title keeps its own. A
    // title segment without a background would punch holes through a filled
    // surface, so the WHOLE assembled line wraps in the ground.
    const leadStyled = colorize(leadGlyphs, edge.color, 'foreground')
    const tailStyled = colorize(tailGlyphs, edge.color, 'foreground')
    let assembled =
      (edge.dim ? chalk.dim(leadStyled) : leadStyled) +
      title.content +
      (edge.dim ? chalk.dim(tailStyled) : tailStyled)
    if (ground) assembled = colorize(assembled, ground, 'background')
    return assembled
  }

  const verticalColumn = (edge: Edge, glyph: string, startRow: number, rows: number): string => {
    if (rows <= 0) return ''
    let hasGround = false
    for (let i = 0; i < rows; i++) {
      if (groundAt(startRow + i)) {
        hasGround = true
        break
      }
    }
    if (!hasGround) {
      // The exact pre-ground byte shape: the coloured glyph plus a newline
      // repeated per interior row, with dim over the whole run.
      const coloured = colorize(glyph, edge.color, 'foreground')
      const run = (coloured + '\n').repeat(rows)
      return edge.dim ? chalk.dim(run) : run
    }
    let out = ''
    for (let i = 0; i < rows; i++) {
      out += styleRun(glyph, edge, groundAt(startRow + i)) + '\n'
    }
    return out
  }

  const interiorRows =
    height - (top.visible ? 1 : 0) - (bottom.visible ? 1 : 0)
  const verticalOffset = top.visible ? 1 : 0

  if (top.visible) {
    output.write(
      x,
      y,
      horizontalLine(
        top,
        glyphs.top,
        glyphs.topLeft,
        glyphs.topRight,
        y,
        style.borderText?.position === 'top',
      ),
    )
  }
  if (left.visible) {
    output.write(
      x,
      y + verticalOffset,
      verticalColumn(left, glyphs.left, y + verticalOffset, interiorRows),
    )
  }
  if (right.visible) {
    output.write(
      x + width - 1,
      y + verticalOffset,
      verticalColumn(right, glyphs.right, y + verticalOffset, interiorRows),
    )
  }
  if (bottom.visible) {
    output.write(
      x,
      y + height - 1,
      horizontalLine(
        bottom,
        glyphs.bottom,
        glyphs.bottomLeft,
        glyphs.bottomRight,
        y + height - 1,
        style.borderText?.position === 'bottom',
      ),
    )
  }
}
