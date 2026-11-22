import { reduceAnsiCodes, tokenize, undoAnsiCodes, type AnsiCode } from '@alcalzone/ansi-tokenize'

import type { Theme } from './theme.js'
import type { HexColor } from '../ink/styles.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type TextHighlight = Unbuilt

type TextSegment = Unbuilt

export function segmentTextByHighlights(text: string, highlights: TextHighlight[]): TextSegment[] {
  return notBuilt('src/utils/textHighlighting.ts:41')
}
