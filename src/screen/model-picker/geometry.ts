import { wrapText } from '../themedRenderer.js'
import { fitMeasuredWindow, paneWindow, type PaneWindow } from '../widgets/geometry.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { wrapPlain } from '../boot-face/BootHealthScreen.js'
import { effortStripText } from '../widgets/EffortStrip.js'
import { GLYPH } from '../theme/glyphs.js'
import { AMBER, FAINT, TEAL } from '../theme/mercuryPalette.js'
import { headingIndexOf, type PickerLine } from '../../models/facts/modelPickerGroups.js'
import type { localRecordFor } from '../../models/roads/local/localCatalogue.js'
import { localWindowChoiceLine, localWindowNoticeKind } from '../../models/roads/local/localWindow.js'
import type { ModelChoice } from './choice.js'

export const ROW_PAD_RIGHT = 1
export const TAG_LEAD = 2

type GeometryArgs = {
  inner: number
  lines: PickerLine<ModelChoice>[]
  compact: boolean
  i: number
  focusedModel: ModelChoice | undefined
  listed: ModelChoice[]
  currentRow: string
  current: string
  pendingNext: string | undefined
  focusedLocal: ReturnType<typeof localRecordFor>
  windowTyping: string | null
  tokens: ReturnType<typeof useMercuryTokens>
  ctxNotice: string | null
  notice: string | undefined
  panelView: boolean
  live: string | undefined
  shedMeters: boolean
  hasEffort: boolean
  efforts: string[] | undefined
  effort: string | undefined
  availRows: number
  localOffer: boolean
  totalLines: number
}

export function pickerGeometry({ inner, lines, compact, i, focusedModel, listed, currentRow, current, pendingNext, focusedLocal, windowTyping, tokens, ctxNotice, notice, panelView, live, shedMeters, hasEffort, efforts, effort, availRows, localOffer, totalLines }: GeometryArgs) {
  const cardWidth = inner - 4
  const tagWidth = Math.max(1, inner - ROW_PAD_RIGHT - TAG_LEAD)
  const linePaint = (idx: number): number => {
    const line = lines[idx]
    if (!line) return 0
    if (line.kind !== 'row') return 1
    if (compact || idx !== i) return 1
    if (line.row.tensorfold !== undefined) return 1 + line.row.tensorfold.card(cardWidth).length
    const tag = line.row.tag
    return tag === '' ? 1 : 1 + wrapText(tag, tagWidth, 'wrap').split('\n').length
  }
  const reasonLines: string[] | null =
    focusedModel !== undefined && (focusedModel.gated || focusedModel.pending) && focusedModel.gatedReason
      ? wrapPlain(
          focusedModel.pending
            ? `${focusedModel.id} · ${focusedModel.gatedReason}`
            : `${focusedModel.id} · ${focusedModel.gatedReason} — not selectable`,
          inner,
        )
      : null
  const painted = (text: string): number => wrapText(text, inner, 'wrap').split('\n').length
  const pendingLine = pendingNext
    ? [
        { text: 'current ', color: FAINT },
        { text: listed.find(m => m.id === currentRow)?.name ?? current, color: TEAL },
        { text: ' · ', color: FAINT },
        { text: `${GLYPH.pending} next `, color: AMBER },
        { text: listed.find(m => m.id === pendingNext)?.name ?? pendingNext, color: AMBER },
        { text: ' · applies when the turn settles', color: FAINT },
      ]
    : null
  const localWindowLine = focusedLocal !== undefined ? localWindowChoiceLine(focusedLocal, { wide: inner >= 90, ...(windowTyping !== null ? { typing: windowTyping } : {}) }) : null
  const noticeInk = localWindowLine !== null && localWindowNoticeKind(localWindowLine) === 'warning' ? tokens.warning : tokens.failureText
  const noticeLines: string[] = compact
    ? []
    : ctxNotice
      ? wrapPlain(ctxNotice, inner)
      : reasonLines !== null
        ? reasonLines
        : [...(localWindowLine !== null ? wrapPlain(localWindowLine, inner) : []), ...(notice ? wrapPlain(notice, inner) : [])]
  const liveLine = panelView && live !== undefined && live !== ''
  const chromeBase =
    2 + 1 + (compact ? 0 : 2) + (panelView ? (liveLine ? 1 : 0) : shedMeters ? 0 : 1) + 2 +
    (pendingLine !== null ? painted(pendingLine.map(part => part.text).join('')) : 0) +
    noticeLines.length + (localOffer ? 1 : 0)
  const effortPaint = hasEffort && !panelView ? (compact ? 1 : painted(effortStripText(efforts!, effort))) : 0
  const shedPageHint = panelView || (compact && availRows - chromeBase - 1 - effortPaint < 4)
  const chromePaint = chromeBase + (shedPageHint ? 0 : 1)
  const shedEffort = compact && effortPaint > 0 && availRows - chromePaint - effortPaint < 4
  const room = availRows - chromePaint - (shedEffort ? 0 : effortPaint)
  const paintBudget = Math.max(1, room)
  const markersOn = room >= 3
  const pinnedOn = room >= 4
  const headingAbove = (w: PaneWindow): number => {
    if (!pinnedOn || w.above === 0) return -1
    const first = lines[w.start]
    if (first === undefined || first.kind === 'heading') return -1
    const at = headingIndexOf(lines, first.kind === 'row' ? first.row.group : first.group)
    return at >= 0 && at < w.start ? at : -1
  }
  const windowPaint = (w: PaneWindow): number => {
    let sum = (markersOn && w.above > 0 ? 1 : 0) + (markersOn && w.below > 0 ? 1 : 0) + (headingAbove(w) >= 0 ? 1 : 0)
    for (let idx = w.start; idx < w.end; idx++) sum += linePaint(idx)
    return sum
  }
  const win = fitMeasuredWindow(totalLines, paintBudget, span => paneWindow(totalLines, i, span), windowPaint)
  return { cardWidth, tagWidth, reasonLines, pendingLine, localWindowLine, noticeInk, noticeLines, liveLine, shedPageHint, shedEffort, paintBudget, markersOn, headingAbove, windowPaint, win }
}
