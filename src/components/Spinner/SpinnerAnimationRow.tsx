import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import type { Theme } from '../../utils/theme.js'
import { getTheme } from '../../utils/theme.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { gaugeColor } from '../mercury-ui/theme.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { getLiveContextUsage } from '../../utils/cockpit/contextUsageLive.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { THINKING_COLOR, THINKING_WORD } from '../messages/thinkingGrammar.js'
import { isQuicksilverLine } from '../../constants/spinnerVerbs.js'
import type { SpinnerMode } from './types.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'
import { turnStripLines } from './stripHeight.js'
import { planSpinnerHud, type HudSegment } from './spinnerHud.js'

const SLOW_TICK_MS = WORK_TICK_MS * 2
const THINKING_SHIMMER_SUPPRESS_MS = 3000
const THINKING_SHIMMER_PERIOD_MS = 2000

type SpinnerAnimationRowProps = {
  mode: SpinnerMode
  reducedMotion: boolean
  activeToolCount: number
  responseLengthRef: React.RefObject<number>
  outputTokensRef?: React.RefObject<number | null>
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
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
  effortSuffix?: string
  inWorkCapsule?: boolean
  still?: boolean
}

export function SpinnerAnimationRow(props: SpinnerAnimationRowProps): React.ReactNode {
  const {
    mode,
    reducedMotion,
    activeToolCount,
    responseLengthRef,
    outputTokensRef,
    liveTurnFactsRef,
    message,
    messageColor,
    shimmerColor,
    overrideColor,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    spinnerSuffix,
    verbose,
    columns,
    effortSuffix,
    inWorkCapsule = false,
    still = false,
  } = props
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const tokens = useMercuryTokens()
  const now = Date.now()

  if (loadingStartTimeRef.current === 0) {
    loadingStartTimeRef.current = now
  }
  const earliestStartRef = useRef(loadingStartTimeRef.current)
  if (loadingStartTimeRef.current < earliestStartRef.current) {
    earliestStartRef.current = loadingStartTimeRef.current
  }
  const pauseHeld = pauseStartTimeRef.current !== null ? now - pauseStartTimeRef.current : 0
  const segmentElapsed = now - loadingStartTimeRef.current - totalPausedMsRef.current - pauseHeld
  const anchoredElapsed = now - earliestStartRef.current - totalPausedMsRef.current - pauseHeld
  const effectiveElapsedMs = Math.max(segmentElapsed, anchoredElapsed, 0)

  const [workRef, workTime] = useAnimationValue(reducedMotion ? null : WORK_TICK_MS, time => time)
  const [, focalTime] = useAnimationValue(reducedMotion || mode !== 'requesting' ? null : FOCAL_TICK_MS, time => time)
  const [, slowTime] = useAnimationValue(reducedMotion ? null : SLOW_TICK_MS, time => time)
  const time = Math.max(workTime, focalTime, slowTime)

  const { stillWaiting, attentionIntensity } = useStalledAnimation(time, {
    mode,
    currentResponseLength: responseLengthRef.current ?? 0,
    suppressed: overrideColor !== null,
    reducedMotion,
  })

  const currentResponseLength = responseLengthRef.current ?? 0
  useAnimationValue(reducedMotion ? null : FOCAL_TICK_MS, () => responseLengthRef.current ?? 0)
  const liveWords = liveCounterWords(
    { ...(liveTurnFactsRef?.current ?? turnFactsOfRefs(currentResponseLength, outputTokensRef?.current ?? null)), phase: liveCounterPhaseOf(mode), sentAtMs: now - effectiveElapsedMs },
    now,
  )

  const rateSampleRef = useRef({ at: 0, len: 0 })
  const smoothedOtpsRef = useRef(0)
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

  const ctxPctRaw = getLiveContextUsage().usedPct
  const ctxPct = ctxPctRaw != null ? Math.round(ctxPctRaw) : null
  const suffixText = spinnerSuffix ?? ''

  const plan = planSpinnerHud(
    {
      mode,
      message,
      columns,
      verbose,
      still,
      suffixText,
      stillWaiting,
      thinkingLabel: `${THINKING_WORD}${effortSuffix ?? ''}`,
      liveWords,
      livePhase: liveCounterPhaseOf(mode),
      effectiveElapsedMs,
      ctxPct,
      activeToolCount,
      otps,
      wasStacked: stackedLatchRef.current,
    },
    wanted => turnStripLines(loadingStartTimeRef.current, wanted),
  )
  stackedLatchRef.current = plan.stacked
  const { ordered, secondRow, showCtx, showWif, showOtps, wifText, otpsText, ctxSpark } = plan

  const displayedHead = message.split(' · ')[0]!.replace(/…\s*$/, '').trim()
  const cadence = isQuicksilverLine(displayedHead) ? 'quicksilver' : 'standard'
  const frame = Math.floor(time / WORK_TICK_MS)
  const [shimmerRef, glimmerIndex] = useShimmerAnimation(mode, message, stillWaiting)
  const flashOpacity = mode === 'tool-use' && !reducedMotion ? (Math.sin((slowTime / 2000) * Math.PI * 2) + 1) / 2 : 0
  const effectiveIntensity = overrideColor !== null ? 0 : attentionIntensity

  const thinkingSinceRef = useRef<number | null>(null)
  if (mode !== 'thinking') thinkingSinceRef.current = null
  else if (thinkingSinceRef.current === null) thinkingSinceRef.current = time
  const thinkingAgeMs = thinkingSinceRef.current === null ? 0 : time - thinkingSinceRef.current
  const shimmerActive = mode === 'thinking' && !reducedMotion && thinkingAgeMs > THINKING_SHIMMER_SUPPRESS_MS
  const shimmerPhase = (Math.sin((time / THINKING_SHIMMER_PERIOD_MS) * Math.PI * 2) + 1) / 2
  const metaColor = (segment: HudSegment): string | undefined => {
    if (segment.kind === 'waiting') return theme.warning
    if (segment.kind === 'thinking') {
      if (!shimmerActive) return THINKING_COLOR
      const grey = Math.round(120 + shimmerPhase * 60)
      return `rgb(${grey},${grey},${grey})`
    }
    return undefined
  }

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
  const metaGroup = !plan.metaVisible ? null : plan.onlyThinking && !plan.gaugesVisible ? (
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
  const segBTail = metaGroup
  const segBVisible = plan.segBVisible

  return (
    <Box flexDirection="column" width="100%" marginTop={inWorkCapsule ? 0 : 1}>
      <Box flexDirection="row" width="100%">
        {still ? (
          <Box ref={workRef} flexWrap="wrap" height={1} width={2}>
            <Text color={overrideColor ?? messageColor}>{GLYPH.spark}</Text>
          </Box>
        ) : (
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
        )}
        <Box ref={shimmerRef}>
          {still ? (
            <Text color={overrideColor ?? messageColor}>{message}</Text>
          ) : (
            <GlimmerMessage
              message={message}
              mode={mode}
              messageColor={overrideColor ?? messageColor}
              glimmerIndex={glimmerIndex}
              flashOpacity={flashOpacity}
              shimmerColor={overrideColor ?? shimmerColor}
              attentionIntensity={effectiveIntensity}
            />
          )}
        </Box>
        {!secondRow && segBVisible ? (
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
      {secondRow ? (
        <Box flexDirection="row" height={1} width="100%">
          {segBVisible ? (
            <Text wrap="truncate-end">
              {suffixText !== '' ? (
                <Text dimColor>
                  {suffixText}
                  {segBTail !== null ? ' ' : ''}
                </Text>
              ) : null}
              {segBTail}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
