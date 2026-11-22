import chalk from 'chalk'
import cliBoxes, { type BoxStyle } from 'cli-boxes'
import { colorize } from './colorize.js'
import type ComposeBuffer from './compose-buffer.js'
import type { DOMElement } from './dom.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import { notBuilt, unbuilt } from '../pi/holes.js'

export type BorderStyle = keyof typeof cliBoxes | 'dashed' | BoxStyle

const CUSTOM_BORDER_STYLES: Record<string, BoxStyle> = unbuilt('src/ink/render-border.ts:19')

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
  return notBuilt('src/ink/render-border.ts:43')
}
