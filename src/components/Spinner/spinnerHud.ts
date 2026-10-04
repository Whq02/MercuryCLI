import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { GLYPH, SPARK } from '../mercury-ui/glyphs.js'
import { THINKING_WORD } from '../messages/thinkingGrammar.js'
import type { LiveCounterWords } from './liveCounterWords.js'
import type { SpinnerMode } from './types.js'

export const STACK_EXIT_SLACK = 6

export function spinnerStackDecision(facts: {
  eligible: boolean
  cost: number
  space: number
  wasStacked: boolean
}): boolean {
  if (!facts.eligible) return false
  if (facts.cost > facts.space) return true
  return facts.wasStacked && facts.cost > facts.space - STACK_EXIT_SLACK
}

export const RAIL_INSET = 2
const SEPARATOR_WIDTH = 3
const HUD_ORDER = ['phase', 'timer', 'tokens', 'promise', 'thinking', 'waiting'] as const

export type HudSegmentKind = 'thinking' | 'waiting'
export type HudSegment = { key: string; text: string; kind?: HudSegmentKind }

export type HudFacts = {
  mode: SpinnerMode
  message: string
  columns: number
  verbose: boolean
  still: boolean
  suffixText: string
  stillWaiting: boolean
  thinkingLabel: string
  liveWords: LiveCounterWords
  livePhase: string
  effectiveElapsedMs: number
  hasRunningCrewmates: boolean
  displayedTokens: number
  tokensEstimated: boolean
  crewmateOnlyTokens: number | null
  ctxPct: number | null
  activeToolCount: number
  otps: number
  interruptHint: string | null
  foregroundedIdleQuiet: boolean
  wasStacked: boolean
}

export type HudPlan = {
  stacked: boolean
  secondRow: boolean
  ordered: HudSegment[]
  showCtx: boolean
  showWif: boolean
  showOtps: boolean
  ctxPct: number | null
  ctxSpark: string
  wifText: string
  otpsText: string
  metaVisible: boolean
  onlyThinking: boolean
  gaugesVisible: boolean
  segBVisible: boolean
}

export function hudTokensText(facts: Pick<HudFacts, 'crewmateOnlyTokens' | 'hasRunningCrewmates' | 'displayedTokens' | 'tokensEstimated' | 'liveWords'>): string | null {
  if (facts.crewmateOnlyTokens !== null || facts.hasRunningCrewmates) {
    return facts.displayedTokens > 0 ? `${facts.tokensEstimated ? '~' : ''}${formatNumber(facts.displayedTokens)} tokens` : null
  }
  return facts.liveWords.count
}

export function hudCtxSpark(ctxPct: number | null): string {
  return ctxPct != null ? SPARK[Math.min(SPARK.length - 1, Math.floor((ctxPct / 100) * SPARK.length))]! : ''
}

export function planSpinnerHud(facts: HudFacts, stripLines: (wanted: number) => number): HudPlan {
  const { mode, liveWords, stillWaiting, effectiveElapsedMs, columns, suffixText } = facts
  const messageWidth = stringWidth(facts.message) + 2
  const suffixWidth = suffixText === '' ? 0 : stringWidth(suffixText) + SEPARATOR_WIDTH
  const waitPhaseText = liveWords.reading || liveWords.phase !== facts.livePhase ? liveWords.phase : null
  const thinkingText = mode === 'thinking' && waitPhaseText === null ? facts.thinkingLabel : null
  const promiseText = liveWords.promise
  const timerText = formatDuration(effectiveElapsedMs, { mostSignificantOnly: true })
  const metaGate = facts.verbose || facts.hasRunningCrewmates || effectiveElapsedMs > 0
  const tokensText = hudTokensText(facts)
  const ctxPct = facts.ctxPct
  const ctxSpark = hudCtxSpark(ctxPct)
  const ctxText = ctxPct != null ? `${ctxSpark} ${ctxPct}% ctx` : ''
  const ctxWidth = stringWidth(ctxText) + SEPARATOR_WIDTH
  const wifText = facts.activeToolCount >= 2 ? `${GLYPH.inProgress} ${facts.activeToolCount} tools` : ''
  const wifWidth = stringWidth(wifText) + SEPARATOR_WIDTH
  const otpsEligible = (mode === 'responding' || mode === 'tool-input') && facts.otps >= 1
  const otpsText = otpsEligible ? `~${facts.otps} tok/s` : ''
  const otpsWidth = stringWidth(otpsText) + SEPARATOR_WIDTH

  const fullSegmentTexts: string[] = []
  if (stillWaiting) fullSegmentTexts.push('still waiting…')
  if (thinkingText !== null) fullSegmentTexts.push(thinkingText)
  if (waitPhaseText !== null) fullSegmentTexts.push(waitPhaseText)
  if (metaGate && effectiveElapsedMs >= 1000) fullSegmentTexts.push(timerText)
  if (metaGate && tokensText !== null) fullSegmentTexts.push(tokensText)
  if (metaGate && ctxPct != null) fullSegmentTexts.push(ctxText)
  if (metaGate && wifText !== '') fullSegmentTexts.push(wifText)
  if (metaGate && otpsText !== '') fullSegmentTexts.push(otpsText)
  if (promiseText !== null) fullSegmentTexts.push(promiseText)
  const fullMetaCost = fullSegmentTexts.reduce((sum, text) => sum + stringWidth(text) + SEPARATOR_WIDTH, 0)
  const segBFullCost =
    facts.interruptHint !== null
      ? stringWidth(facts.interruptHint) + 2 + SEPARATOR_WIDTH
      : facts.foregroundedIdleQuiet
        ? 0
        : fullMetaCost
  const railSpace = columns - RAIL_INSET
  const oneLineSpace = railSpace - messageWidth - suffixWidth - 5
  const stacked = spinnerStackDecision({
    eligible: segBFullCost > 0 || suffixText !== '',
    cost: segBFullCost,
    space: oneLineSpace,
    wasStacked: facts.wasStacked,
  })
  const secondRow = stripLines(stacked ? 2 : 1) > 1
  const availableSpace = secondRow ? railSpace - suffixWidth - 5 : oneLineSpace

  const admitted: HudSegment[] = []
  let used = 0
  const admit = (segment: HudSegment): boolean => {
    const cost = stringWidth(segment.text) + SEPARATOR_WIDTH
    if (availableSpace - used - cost < 0) return false
    used += cost
    admitted.push(segment)
    return true
  }
  if (stillWaiting) admit({ key: 'waiting', text: 'still waiting…', kind: 'waiting' })
  if (thinkingText !== null) {
    if (!admit({ key: 'thinking', text: thinkingText, kind: 'thinking' })) {
      admit({ key: 'thinking', text: THINKING_WORD, kind: 'thinking' })
    }
  }
  if (waitPhaseText !== null) admit({ key: 'phase', text: waitPhaseText })
  if (metaGate && effectiveElapsedMs >= 1000) admit({ key: 'timer', text: timerText })
  if (metaGate && tokensText !== null) admit({ key: 'tokens', text: tokensText })
  const usedAfterTokens = used
  const showCtx = metaGate && ctxPct != null && availableSpace > usedAfterTokens + ctxWidth
  if (showCtx) used += ctxWidth
  const usedAfterCtx = used
  const showWif = metaGate && wifText !== '' && availableSpace > usedAfterCtx + wifWidth
  if (showWif) used += wifWidth
  const usedAfterWif = used
  const showOtps = metaGate && otpsText !== '' && availableSpace > usedAfterWif + otpsWidth
  if (showOtps) used += otpsWidth
  if (promiseText !== null) admit({ key: 'promise', text: promiseText })

  const ordered = HUD_ORDER.map(key => admitted.find(segment => segment.key === key)).filter(
    (segment): segment is HudSegment => segment !== undefined,
  )
  const onlyThinking = ordered.length === 1 && ordered[0]!.kind === 'thinking'
  const gaugesVisible = showCtx || showWif || showOtps
  const metaVisible = ordered.length > 0 || gaugesVisible
  const segBTailPresent = facts.interruptHint !== null || (!facts.foregroundedIdleQuiet && metaVisible)
  const segBVisible = !facts.still && (suffixText !== '' || segBTailPresent)
  return { stacked, secondRow, ordered, showCtx, showWif, showOtps, ctxPct, ctxSpark, wifText, otpsText, metaVisible, onlyThinking, gaugesVisible, segBVisible }
}
