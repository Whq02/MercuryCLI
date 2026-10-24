import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration } from '../../utils/format.js'
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

const RAIL_INSET = 2
const SEPARATOR_WIDTH = 3
const HUD_ORDER = ['timer', 'tokens', 'attention'] as const

export type HudSegment = { key: string; text: string }

type HudFacts = {
  mode: SpinnerMode
  message: string
  columns: number
  verbose: boolean
  still: boolean
  suffixText: string
  liveWords: LiveCounterWords
  effectiveElapsedMs: number
  otps: number
  wasStacked: boolean
}

export function hudTokensText(facts: Pick<HudFacts, 'liveWords'>): string | null {
  return facts.liveWords.count
}

export function planSpinnerHud(facts: HudFacts, stripLines: (wanted: number) => number) {
  const { mode, liveWords, effectiveElapsedMs, columns, suffixText } = facts
  const messageWidth = stringWidth(facts.message) + 2
  const suffixWidth = suffixText === '' ? 0 : stringWidth(suffixText) + SEPARATOR_WIDTH
  const timerText = formatDuration(effectiveElapsedMs)
  const metaGate = facts.verbose || effectiveElapsedMs > 0
  const tokensText = hudTokensText(facts)
  const attentionText = liveWords.promise
  const otpsEligible = (mode === 'responding' || mode === 'tool-input') && facts.otps >= 1
  const otpsText = otpsEligible ? `~${facts.otps} tok/s` : ''
  const otpsWidth = stringWidth(otpsText) + SEPARATOR_WIDTH

  const fullSegmentTexts: string[] = []
  if (metaGate && effectiveElapsedMs >= 1000) fullSegmentTexts.push(timerText)
  if (metaGate && tokensText !== null) fullSegmentTexts.push(tokensText)
  if (metaGate && otpsText !== '') fullSegmentTexts.push(otpsText)
  if (attentionText !== null) fullSegmentTexts.push(attentionText)
  const segBFullCost = fullSegmentTexts.reduce((sum, text) => sum + stringWidth(text) + SEPARATOR_WIDTH, 0)
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
  if (attentionText !== null) admit({ key: 'attention', text: attentionText })
  if (metaGate && effectiveElapsedMs >= 1000) admit({ key: 'timer', text: timerText })
  if (metaGate && tokensText !== null) admit({ key: 'tokens', text: tokensText })
  const showOtps = metaGate && otpsText !== '' && availableSpace > used + otpsWidth
  const ordered = HUD_ORDER.map(key => admitted.find(segment => segment.key === key)).filter(
    (segment): segment is HudSegment => segment !== undefined,
  )
  const metaVisible = ordered.length > 0 || showOtps
  const segBVisible = !facts.still && (suffixText !== '' || metaVisible)
  return { stacked, secondRow, ordered, showOtps, otpsText, metaVisible, segBVisible }
}
