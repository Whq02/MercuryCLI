import sliceAnsi from './sliceAnsi.js'
import { stringWidth } from '../ink/stringWidth.js'
import { ctrlOToExpand } from './ctrlOToExpand.js'
import { notBuilt } from '../pi/holes.js'

const VISIBLE_LINES = 3

const WIDTH_ALLOWANCE = 12

const MIN_WRAP_WIDTH = 10

export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint?: boolean,
): string {
  return notBuilt('src/utils/terminal.ts:12')
}

export function isOutputLineTruncated(content: string): boolean {
  return notBuilt('src/utils/terminal.ts:60')
}
