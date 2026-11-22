import { createScanner } from './input/scanner.js'
import { stringWidth } from './stringWidth.js'
import { notBuilt } from '../pi/holes.js'

export function expandTabsWithColumn(
  text: string,
  startColumn: number,
  interval?: number,
): { text: string; column: number } {
  return notBuilt('src/ink/tabstops.ts:5')
}

export function expandTabs(text: string, interval = 8): string {
  return expandTabsWithColumn(text, 0, interval).text
}
