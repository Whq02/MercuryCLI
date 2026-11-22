import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'
import { notBuilt } from '../pi/holes.js'


const ELLIPSIS = '…'

export function truncateToWidth(text: string, maxWidth: number): string {
  return notBuilt('src/utils/truncate.ts:15')
}

export function truncateStartToWidth(text: string, maxWidth: number): string {
  return notBuilt('src/utils/truncate.ts:29')
}

export function truncateKeepingTail(text: string, maxWidth: number, keepTail?: number): string {
  return notBuilt('src/utils/truncate.ts:45')
}

export function truncateToWidthNoEllipsis(text: string, maxWidth: number): string {
  return notBuilt('src/utils/truncate.ts:87')
}

export function truncatePathMiddle(path: string, maxLength: number): string {
  return notBuilt('src/utils/truncate.ts:101')
}

export function truncate(str: string, maxWidth: number, singleLine?: boolean): string {
  return notBuilt('src/utils/truncate.ts:119')
}

export { default as wrapText } from '../ink/wrap-text.js'
