// The animated working row: clocks on the shared 80 ⊂ 160 ⊂ 320
// lattice, the anchored elapsed timer, the eased token counter, the cockpit
// HUD gauges (context burn · work-in-flight · streaming cadence — sourced,
// ramped, width-gated, honest), and the meta byline whose ADMISSION order
// is not its RENDERED order — the still-waiting suffix and the thinking
// label are admitted first and painted last.


import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { Theme } from '../../utils/theme.js'
import { getTheme } from '../../utils/theme.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { gaugeColor } from '../mercury-ui/theme.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { getLiveContextUsage } from '../../utils/cockpit/contextUsageLive.js'
import { usePulsePhase } from '../../utils/pulse/turnPhase.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { GLYPH, SPARK } from '../mercury-ui/glyphs.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import {
  IDLE_THINKING_TRACKER,
  composePhaseByline,
  nextDisplayedPhase,
  nextThinkingSpan,
  thinkingPostscript,
} from './pulseByline.js'
import { THINKING_COLOR, THINKING_WORD } from '../messages/thinkingGrammar.js'
import { isQuicksilverLine } from '../../constants/spinnerVerbs.js'
import type { SpinnerMode } from './types.js'
import { teammateRole } from '../tasks/taskStatusUtils.js'

/** The one-line↔stacked decision behind a hysteresis band:
 *  the stack cost includes counters whose WIDTH jitters every
 *  animation tick (tok/s, the k-counter), so the raw `cost > space`
 *  comparison flipped the working row between one and two rows on
 *  successive ticks near the boundary — the transcript above jumped a row
 *  once a second. Stacking engages the moment the cost exceeds the space
 *  (the honest response to a tight line is a second row, never a thinner
 *  HUD); UNSTACKING waits until the cost fits with STACK_EXIT_SLACK cells
 *  to spare — wider than the counters' per-tick width jitter (a k-digit +
 *  a tok/s digit + separators ≈ 4), so a wobble cannot re-cross. A real
 *  resize moves `space` itself and re-decides through the same band. Pure
 *  and exported — prove-resize-laws drives it. */
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


const SLOW_TICK_MS = WORK_TICK_MS * 2 // 320 — the flash/throughput slice
const RAIL_INSET = 2
const THINKING_SHIMMER_SUPPRESS_MS = 3000
const THINKING_SHIMMER_PERIOD_MS = 2000

export type SpinnerAnimationRowProps = {
  mode: SpinnerMode
  reducedMotion: boolean
  hasActiveTools: boolean
  activeToolCount: number
  responseLengthRef: React.RefObject<number>
  message: string
  messageColor: keyof Theme
  shimmerColor: keyof Theme
  overrideColor: keyof Theme | null
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  spinnerSuffix?: string | null
  verbose: boolean
  columns: number
  hasRunningTeammates: boolean
  teammateTokens: number
  foregroundedTeammate: InProcessTeammateTaskState | undefined
  leaderIsIdle?: boolean
  effortSuffix?: string
  phaseBylineEligible: boolean
  bylineVerb?: string
  ttftText?: string | null
  inWorkCapsule?: boolean
}

/** Token-easing step: scales with the gap, never overshoots. */
function easeStep(gap: number): number {
  if (gap < 70) return 5
  if (gap < 200) return Math.max(13, Math.floor(gap / 4))
  return 80
}

export function SpinnerAnimationRow(
  props: SpinnerAnimationRowProps,
): React.ReactNode {
  const {
    mode,
    reducedMotion,
    hasActiveTools,
    activeToolCount,
    responseLengthRef,
    message: messageProp,
    messageColor,
    shimmerColor,
    overrideColor,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    spinnerSuffix,
    verbose,
    columns,
    hasRunningTeammates,
    teammateTokens,
    foregroundedTeammate,
    leaderIsIdle,
    effortSuffix,
    phaseBylineEligible,
    bylineVerb,
    ttftText,
    inWorkCapsule = false,
  } = props
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const tokens = useMercuryTokens()
  const snapshot = usePulsePhase()
  const pulseOpen = snapshot.generation > 0 && snapshot.phase !== 'idle'
  const now = Date.now()

  // INC-4549 floor: an unstamped turn clock is floored to the spinner mount
  // frame — never an epoch-zero elapsed.
  if (loadingStartTimeRef.current === 0) {
    loadingStartTimeRef.current = now
  }
  const earliestStartRef = useRef(loadingStartTimeRef.current)
  if (loadingStartTimeRef.current < earliestStartRef.current) {
    earliestStartRef.current = loadingStartTimeRef.current
  }
  const pauseHeld =
    pauseStartTimeRef.current !== null ? now - pauseStartTimeRef.current : 0
  const segmentElapsed =
    now - loadingStartTimeRef.current - totalPausedMsRef.current - pauseHeld
  const anchoredElapsed =
    now - earliestStartRef.current - totalPausedMsRef.current - pauseHeld
  const effectiveElapsedMs = Math.max(segmentElapsed, anchoredElapsed, 0)

  // ── the shared lattice slices ────────────────────────────────────────────
  const [workRef, workTime] = useAnimationValue(
    reducedMotion ? null : WORK_TICK_MS,
    time => time,
  )
  const [, focalTime] = useAnimationValue(
    reducedMotion || mode !== 'requesting' ? null : FOCAL_TICK_MS,
    time => time,
  )
  const [, slowTime] = useAnimationValue(
    reducedMotion ? null : SLOW_TICK_MS,
    time => time,
  )
  // Merged: max of live slices — it can step BACKWARDS when a conditional
  // slice stops; nothing anchors one-shot state to it.
  const time = Math.max(workTime, focalTime, slowTime)

  const { stillWaiting, attentionIntensity } = useStalledAnimation(time, {
    pulseOpen,
    phase: snapshot.phase,
    mode,
    currentResponseLength: responseLengthRef.current ?? 0,
    suppressed: overrideColor !== null,
    reducedMotion,
  })

  // ── token counter easing (conditional FOCAL slice) ───────────────────────
  const displayedCountRef = useRef(0)
  const currentResponseLength = responseLengthRef.current ?? 0
  const [, easedCount] = useAnimationValue(
    reducedMotion || displayedCountRef.current >= currentResponseLength
      ? null
      : FOCAL_TICK_MS,
    () => {
      const current = displayedCountRef.current
      const gap = currentResponseLength - current
      if (gap <= 0) return current
      const next = Math.min(currentResponseLength, current + easeStep(gap))
      displayedCountRef.current = next
      return next
    },
  )
  const displayedChars = reducedMotion
    ? currentResponseLength
    : Math.max(
        easedCount,
        Math.min(displayedCountRef.current, currentResponseLength),
      )
  if (reducedMotion) displayedCountRef.current = currentResponseLength
  const foregroundedActive =
    foregroundedTeammate !== undefined &&
    (foregroundedTeammate as { status?: string }).status === 'running' &&
    foregroundedTeammate.isIdle !== true
  const teammateOnlyTokens = foregroundedActive
    ? ((foregroundedTeammate.progress as { totalTokens?: number } | undefined)
        ?.totalTokens ?? 0)
    : null
  const displayedTokens =
    teammateOnlyTokens !== null
      ? teammateOnlyTokens
      : Math.floor(displayedChars / 4) + teammateTokens

  // ── streaming-cadence (tok/s): raw-delta sample, EMA-smoothed ────────────
  const rateSampleRef = useRef({ at: 0, len: 0 })
  const smoothedOtpsRef = useRef(0)
  // B2: the stack hysteresis latch (per instance).
  const stackedLatchRef = useRef(false)
  if (reducedMotion) {
    smoothedOtpsRef.current = 0
  } else {
    const dtMs = now - rateSampleRef.current.at
    if (dtMs >= 250) {
      const deltaChars = currentResponseLength - rateSampleRef.current.len
      if (rateSampleRef.current.at !== 0 && deltaChars >= 0) {
        const instant = deltaChars / 4 / (dtMs / 1000)
        smoothedOtpsRef.current = smoothedOtpsRef.current * 0.6 + instant * 0.4
      }
      rateSampleRef.current = { at: now, len: currentResponseLength }
    }
  }
  const otps = Math.round(smoothedOtpsRef.current)
  const otpsEligible =
    (mode === 'responding' || mode === 'tool-input') && otps >= 1

  // ── phase byline + thinking span ─────────────────────────────────────────
  const displayedPhaseRef = useRef({
    generation: 0,
    phase: 'idle' as typeof snapshot.phase,
  })
  const displayedPhase = nextDisplayedPhase(
    displayedPhaseRef.current,
    snapshot,
    now,
    reducedMotion,
  )
  displayedPhaseRef.current = {
    generation: snapshot.generation,
    phase: displayedPhase,
  }
  const thinkingTrackerRef = useRef(IDLE_THINKING_TRACKER)
  thinkingTrackerRef.current = nextThinkingSpan(
    thinkingTrackerRef.current,
    displayedPhase,
    now,
  )
  const postscript = thinkingPostscript(thinkingTrackerRef.current, now)

  const phaseByline =
    pulseOpen && phaseBylineEligible
      ? composePhaseByline({
          phase: displayedPhase,
          detail: snapshot.detail,
          activeToolCount,
          maxWidth: Math.max(10, columns - 9),
          verb: bylineVerb,
        })
      : null
  const bylineNarratesThinking =
    phaseByline !== null && displayedPhase === 'thinking'

  // ── byline admission (admission order ≠ rendered order) ──────────────────
  const inThinking = pulseOpen
    ? displayedPhase === 'thinking'
    : mode === 'thinking'
  // The HUD word is the thinking grammar's (one spelling beside every model).
  const thinkingLabelFull = `${THINKING_WORD}${effortSuffix ?? ''}`
  // The PAINTED message (the phase byline when it narrates, else the verb
  // chain) is what the meta budget subtracts. Budgeting the RAW verb while
  // painting the longer byline was overflow cause #1 of the jammed-specimen
  // class.
  const message = phaseByline ?? messageProp
  const messageWidth = stringWidth(message) + 2
  const separatorWidth = 3 // ' · '
  // The hook/status suffix heads segment B and joins the budget (overflow
  // cause #2: it would otherwise ride the row entirely unbudgeted).
  const suffixText = spinnerSuffix ?? ''
  const suffixWidth =
    suffixText === '' ? 0 : stringWidth(suffixText) + separatorWidth

  const interruptHint = foregroundedActive
    ? `esc interrupts @${foregroundedTeammate.identity.agentName}`
    : null
  const foregroundedIdleQuiet =
    foregroundedTeammate !== undefined && !foregroundedActive

  // ── the two-segment layout law ──────────────
  // Segment A = glyph + byline; segment B = the hook/status suffix + the
  // parenthesised HUD meta. One line while both fit; otherwise the segments
  // STACK as two rows —
  // stacking, not mid-line wrapping, is the first response to a line that
  // cannot hold both. Shedding stays segment-internal: the byline sheds via
  // its head ladder, the meta sheds right-to-left against its OWN line's
  // budget.
  const thinkingText = inThinking
    ? thinkingLabelFull
    : postscript
  const wantsThinking =
    thinkingText !== null && !(phaseByline !== null && inThinking)
  // HUD order law: action · elapsed · token/ctx burn · work-in-flight —
  // then cadence and TTFT; segments 3–8 share one gate (verbose, running
  // teammates, or any elapsed at all).
  const timerText = formatDuration(effectiveElapsedMs, { mostSignificantOnly: true })
  // Token readout persists from zero — no zero→non-zero shuffle.
  const tokensAfterMs = 0
  void tokensAfterMs
  const metaGate = verbose || hasRunningTeammates || effectiveElapsedMs > 0
  const tokenDirection = hasRunningTeammates
    ? ''
    : mode === 'requesting'
      ? '↑ '
      : '↓ '
  const tokensText = `${tokenDirection}${formatNumber(displayedTokens)} tokens`

  // ── Context-window burn gauge (HUD): sourced from the LIVE published
  // seam, SPARK-ramped, honest — self-omits when usedPct is null. ─────────
  const ctxPctRaw = getLiveContextUsage().usedPct
  const ctxPct = ctxPctRaw != null ? Math.round(ctxPctRaw) : null
  const ctxSpark =
    ctxPct != null
      ? SPARK[Math.min(SPARK.length - 1, Math.floor((ctxPct / 100) * SPARK.length))]
      : ''
  const ctxText = ctxPct != null ? `${ctxSpark} ${ctxPct}% ctx` : ''
  const ctxWidth = stringWidth(ctxText) + separatorWidth

  // ── work-in-flight gauge: parallel tools only. ──────────────────────────
  const wifText =
    activeToolCount >= 2 ? `${GLYPH.inProgress} ${activeToolCount} tools` : ''
  const wifWidth = stringWidth(wifText) + separatorWidth

  // ── streaming cadence. ──────────────────────────────────────────────────
  const otpsText = otpsEligible ? `${otps} tok/s` : ''
  const otpsWidth = stringWidth(otpsText) + separatorWidth

  // Segment B at FULL width (eligibility only, no shedding): the stack
  // decision weighs the whole honest payload, so the first response to a
  // tight line is a second row, never a quietly thinner HUD.
  const fullSegmentTexts: string[] = []
  if (stillWaiting) fullSegmentTexts.push('still waiting…')
  if (wantsThinking && thinkingText !== null) fullSegmentTexts.push(thinkingText)
  if (metaGate && effectiveElapsedMs >= 1000) fullSegmentTexts.push(timerText)
  if (metaGate) fullSegmentTexts.push(tokensText)
  if (metaGate && ctxPct != null) fullSegmentTexts.push(ctxText)
  if (metaGate && wifText !== '') fullSegmentTexts.push(wifText)
  if (metaGate && otpsText !== '') fullSegmentTexts.push(otpsText)
  if (metaGate && ttftText) fullSegmentTexts.push(ttftText)
  const fullMetaCost = fullSegmentTexts.reduce(
    (sum, text) => sum + stringWidth(text) + separatorWidth,
    0,
  )
  const segBFullCost =
    interruptHint !== null
      ? stringWidth(interruptHint) + 2 + separatorWidth
      : foregroundedIdleQuiet
        ? 0
        : fullMetaCost
  const railSpace = columns - RAIL_INSET
  const oneLineSpace = railSpace - messageWidth - suffixWidth - 5
  // B2: the decision rides the pure hysteresis fold — the latch is per
  // instance (a ref), so a settled cold render is byte-identical to the
  // pre-hysteresis frame and only the boundary band holds its shape.
  const stacked = spinnerStackDecision({
    eligible: segBFullCost > 0 || suffixText !== '',
    cost: segBFullCost,
    space: oneLineSpace,
    wasStacked: stackedLatchRef.current,
  })
  stackedLatchRef.current = stacked
  // The meta budget: beside the byline on one line, or segment B's own row.
  const availableSpace = stacked ? railSpace - suffixWidth - 5 : oneLineSpace

  type Segment = { key: string; text: string; kind?: 'thinking' | 'waiting' }
  const admitted: Segment[] = []
  let used = 0
  const admit = (segment: Segment): boolean => {
    const cost = stringWidth(segment.text) + separatorWidth
    if (availableSpace - used - cost < 0) return false
    used += cost
    admitted.push(segment)
    return true
  }

  // 1 · still-waiting suffix (admitted first, painted last).
  if (stillWaiting) {
    admit({ key: 'waiting', text: 'still waiting…', kind: 'waiting' })
  }
  // 2 · the thinking label (the effort suffix drops before the bare label);
  // the live label DEFERS to the byline narration — one phrase, never two.
  if (wantsThinking && thinkingText !== null) {
    if (!admit({ key: 'thinking', text: thinkingText, kind: 'thinking' })) {
      admit({ key: 'thinking', text: THINKING_WORD, kind: 'thinking' })
    }
  }
  // 3+ · the gated HUD segments, in the order law above.
  if (metaGate && effectiveElapsedMs >= 1000) {
    admit({
      key: 'timer',
      text: timerText,
    })
  }
  if (metaGate) {
    admit({
      key: 'tokens',
      text: tokensText,
    })
  }
  const usedAfterTokens = used

  const showCtx =
    metaGate && ctxPct != null && availableSpace > usedAfterTokens + ctxWidth
  if (showCtx) used += ctxWidth
  const usedAfterCtx = used

  const showWif =
    metaGate && wifText !== '' && availableSpace > usedAfterCtx + wifWidth
  if (showWif) used += wifWidth
  const usedAfterWif = used

  const showOtps =
    metaGate && otpsText !== '' && availableSpace > usedAfterWif + otpsWidth
  if (showOtps) used += otpsWidth

  if (metaGate && ttftText) {
    admit({ key: 'ttft', text: ttftText })
  }

  // Rendered order: timer, tokens, ctx, wif, otps, ttft, then thinking,
  // then still-waiting — the two earliest-admitted paint last.
  const orderedKeys = ['timer', 'tokens', 'ttft', 'thinking', 'waiting']
  const ordered = orderedKeys
    .map(key => admitted.find(segment => segment.key === key))
    .filter((segment): segment is Segment => segment !== undefined)

  // ── glyph + message ─────────────────────────────────────────────────────
  const displayedHead = message.split(' · ')[0]!.replace(/…\s*$/, '').trim()
  const cadence = isQuicksilverLine(displayedHead) ? 'quicksilver' : 'standard'
  const frame = Math.floor(time / WORK_TICK_MS)
  const [shimmerRef, glimmerIndex] = useShimmerAnimation(
    mode,
    message,
    stillWaiting,
  )
  const flashOpacity =
    mode === 'tool-use' && !reducedMotion
      ? (Math.sin((slowTime / 2000) * Math.PI * 2) + 1) / 2
      : 0
  const effectiveIntensity = overrideColor !== null ? 0 : attentionIntensity

  const shimmerActive =
    inThinking && !reducedMotion &&
    time > THINKING_SHIMMER_SUPPRESS_MS
  const shimmerPhase =
    (Math.sin((time / THINKING_SHIMMER_PERIOD_MS) * Math.PI * 2) + 1) / 2
  // The thinking segment paints the thinking grammar's colour at rest and the
  // grey shimmer while it breathes; the HUD placement is the row's own.
  const metaColor = (segment: Segment): string | undefined => {
    if (segment.kind === 'waiting') return theme.warning
    if (segment.kind === 'thinking') {
      if (!shimmerActive) return THINKING_COLOR
      const grey = Math.round(120 + shimmerPhase * 60)
      return `rgb(${grey},${grey},${grey})`
    }
    return undefined
  }

  const onlyThinking = ordered.length === 1 && ordered[0]!.kind === 'thinking'
  const gaugesVisible = showCtx || showWif || showOtps
  const metaVisible = ordered.length > 0 || gaugesVisible

  void leaderIsIdle
  void hasActiveTools

  // ── segment B: [suffix ·] (meta), or the interrupt hint ─────────────────
  // Assembled as a node LIST joined by ' · ' — a shed head segment can never
  // strand a leading separator inside the parens (the old hard-coded ' · '
  // prefixes could paint "(· ▂ 6% ctx)" on a narrow line).
  const metaNodes: React.ReactNode[] = []
  for (const segment of ordered.filter(s => s.kind === undefined)) {
    metaNodes.push(<Text key={segment.key}>{segment.text}</Text>)
  }
  if (showCtx && ctxPct != null) {
    metaNodes.push(
      <Text key="ctx">
        <Text color={gaugeColor(ctxPct)}>{ctxSpark} {ctxPct}%</Text>
        <Text color={tokens.textSecondary}>{' ctx'}</Text>
      </Text>,
    )
  }
  if (showWif) {
    metaNodes.push(
      <Text key="wif">
        <Text color={tokens.success}>{wifText}</Text>
      </Text>,
    )
  }
  if (showOtps) {
    metaNodes.push(
      <Text key="otps" color={tokens.textSecondary}>
        {otpsText}
      </Text>,
    )
  }
  for (const segment of ordered.filter(s => s.kind === 'thinking')) {
    metaNodes.push(
      <Text key={segment.key} color={metaColor(segment)}>
        {segment.text}
      </Text>,
    )
  }
  if (ordered.some(segment => segment.kind === 'waiting')) {
    metaNodes.push(
      <Text dimColor italic={true} key="stillWaiting">
        {'still waiting…'}
      </Text>,
    )
  }
  const metaGroup = !metaVisible ? null : onlyThinking && !gaugesVisible ? (
    <Text color={metaColor(ordered[0]!)}>
      ({ordered[0]!.text})
    </Text>
  ) : (
    <Text dimColor>
      {'('}
      {metaNodes.map((node, index) => (
        <React.Fragment key={`m${index}`}>
          {index > 0 ? ' · ' : ''}
          {node}
        </React.Fragment>
      ))}
      {')'}
    </Text>
  )
  const segBTail =
    interruptHint !== null ? (
      <Text color={teammateRole(foregroundedTeammate?.identity.color)}>
        ({interruptHint})
      </Text>
    ) : foregroundedIdleQuiet ? null : (
      metaGroup
    )
  const segBVisible = suffixText !== '' || segBTail !== null

  // THE ANCHOR LAW: this row RESIZES
  // mid-state — growing dots, the ticking elapsed, the eased token count —
  // so it sits flush against the LEFT edge of whatever contains it (the
  // capsule's own border+padding provide the one-cell inset). A centered
  // treatment re-derived the glyph column from the text width every tick,
  // which walked the ✻ back and forth as the text breathed — jank, not
  // polish. Surfaces that never resize mid-state may center; this one never
  // qualifies.
  // One line while both segments fit; two left-anchored rows when they
  // don't — never a mid-segment wrap (the jam), never a lurch (both states
  // share the same column container and the same ' · ' grammar).
  return (
    <Box
      flexDirection="column"
      width="100%"
      marginTop={inWorkCapsule ? 0 : 1}
    >
      <Box flexDirection="row" width="100%">
        <Box ref={workRef}>
          <SpinnerGlyph
            frame={frame}
            messageColor={overrideColor ?? messageColor}
            attentionIntensity={effectiveIntensity}
            reducedMotion={reducedMotion}
            time={time}
            cadence={cadence}
          />
        </Box>
        <Box ref={shimmerRef}>
          <GlimmerMessage
            message={message}
            mode={mode}
            messageColor={overrideColor ?? messageColor}
            glimmerIndex={glimmerIndex}
            flashOpacity={flashOpacity}
            shimmerColor={overrideColor ?? shimmerColor}
            attentionIntensity={effectiveIntensity}
          />
        </Box>
        {!stacked && segBVisible ? (
          <Text>
            {suffixText !== '' ? (
              <Text dimColor>
                {'· '}
                {suffixText}
                {segBTail !== null ? ' ' : ''}
              </Text>
            ) : null}
            {segBTail}
          </Text>
        ) : null}
      </Box>
      {stacked && segBVisible ? (
        <Box flexDirection="row" width="100%">
          <Text>
            {suffixText !== '' ? (
              <Text dimColor>
                {suffixText}
                {segBTail !== null ? ' ' : ''}
              </Text>
            ) : null}
            {segBTail}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
