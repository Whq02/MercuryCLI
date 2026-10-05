import { eastAsianWidthType } from 'get-east-asian-width'
import { stringWidth } from './stringWidth.js'

type TextWidthClass =
  | 'vs16'
  | 'skin'
  | 'zwj'
  | 'flag'
  | 'combining'
  | 'zeroWidth'
  | 'sextant'
  | 'ambiguous'

type Measurements = Readonly<Partial<Record<TextWidthClass, number>>>

const MARK = /\p{M}/u
const SKIN = /[\u{1f3fb}-\u{1f3ff}]/u
const FLAG = /^[\u{1f1e6}-\u{1f1ff}]{2}$/u

function asksEmojiPresentation(cluster: string): boolean {
  for (let i = 0; i < cluster.length; i++) {
    if (cluster.charCodeAt(i) === 0xfe0f) return true
  }
  return false
}

function textWidthClass(cluster: string, cells: number): TextWidthClass | undefined {
  if (cluster.includes('\u20e3')) return undefined
  const joined = cluster.includes('\u200d') && cluster.length > 1
  const toned = SKIN.test(cluster)
  const presentation = asksEmojiPresentation(cluster)
  if (Number(joined) + Number(toned) + Number(presentation) > 1) return undefined
  if (joined) return 'zwj'
  if (toned && [...cluster].length > 1) return 'skin'
  if (FLAG.test(cluster)) return 'flag'
  if (presentation) return cells === 2 ? 'vs16' : undefined
  if (cells === 0 && cluster.length > 0) return 'zeroWidth'
  if (MARK.test(cluster)) return 'combining'
  const point = cluster.codePointAt(0)
  if (point === undefined || String.fromCodePoint(point) !== cluster) return undefined
  if (point >= 0x1fb00 && point <= 0x1fb3b) return 'sextant'
  if (point >= 0x2500 && point <= 0x259f) return undefined
  if (eastAsianWidthType(point) === 'ambiguous') return 'ambiguous'
  return undefined
}

export function measuredWidthAgreement(
  cluster: string,
  measured?: Measurements,
  cells?: number,
): boolean | undefined {
  if (!measured) return undefined
  const width = cells ?? stringWidth(cluster)
  const kind = textWidthClass(cluster, width)
  if (kind === undefined) return undefined
  const advance = measured[kind]
  if (advance === undefined || !Number.isSafeInteger(advance) || advance < 0) return undefined
  return advance === width
}

export function widthMayDisagree(
  cluster: string,
  measured?: Measurements,
  cells?: number,
): boolean {
  const agrees = measuredWidthAgreement(cluster, measured, cells)
  if (agrees !== undefined) return !agrees
  const point = cluster.codePointAt(0)
  return point !== undefined && (
    (point >= 0x1fa70 && point <= 0x1fbff) ||
    (cluster.length >= 2 && asksEmojiPresentation(cluster))
  )
}
