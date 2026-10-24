import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import type { Theme } from '../../utils/theme.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import { getEphemeralProgressFrame, useEphemeralProgressVersion } from '../../state/ephemeralProgressStore.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { useOutputRate } from './useOutputRate.js'
import { isQuicksilverLine } from '../../constants/spinnerVerbs.js'
import type { SpinnerMode } from './types.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'
import { turnStripLines } from './stripHeight.js'
import { planSpinnerHud } from './spinnerHud.js'

const SLOW_TICK_MS = WORK_TICK_MS * 2

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
  hookWaitKeys?: readonly string[]
  verbose: boolean
  columns: number
  effortSuffix?: string
  inWorkCapsule?: boolean
  still?: boolean
}

const NO_KEYS: readonly string[] = []

export function SpinnerAnimationRow(props: SpinnerAnimationRowProps): React.ReactNode {
  const {
    mode,
    reducedMotion,
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
    hookWaitKeys = NO_KEYS,
    verbose,
    columns,
    inWorkCapsule = false,
    still = false,
  } = props
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

  const otps = useOutputRate(
    liveTurnFactsRef?.current.replyChars ?? currentResponseLength,
    !reducedMotion && !still && pauseStartTimeRef.current === null && liveWords.promise === null && (mode === 'responding' || mode === 'tool-input'),
    now,
  )
  const stackedLatchRef = useRef(false)
  useEphemeralProgressVersion(hookWaitKeys)
  const suffixText = spinnerSuffix ?? hookWaitLineOf(hookWaitKeys.map(getEphemeralProgressFrame)) ?? ''

  const plan = planSpinnerHud(
    {
      mode,
      message,
      columns,
      verbose,
      still,
      suffixText,
      liveWords,
      effectiveElapsedMs,
      otps,
      wasStacked: stackedLatchRef.current,
    },
    wanted => turnStripLines(loadingStartTimeRef.current, wanted),
  )
  stackedLatchRef.current = plan.stacked
  const { ordered, secondRow, showOtps, otpsText } = plan

  const displayedHead = message.split(' · ')[0]!.replace(/…\s*$/, '').trim()
  const cadence = isQuicksilverLine(displayedHead) ? 'quicksilver' : 'standard'
  const frame = Math.floor(time / WORK_TICK_MS)
  const [shimmerRef, glimmerIndex] = useShimmerAnimation(mode, message, stillWaiting)
  const flashOpacity = mode === 'tool-use' && !reducedMotion ? (Math.sin((slowTime / 2000) * Math.PI * 2) + 1) / 2 : 0
  const effectiveIntensity = overrideColor !== null ? 0 : attentionIntensity

  const metaNodes: React.ReactNode[] = []
  for (const segment of ordered) {
    metaNodes.push(<Text key={segment.key}>{segment.text}</Text>)
  }
  if (showOtps) {
    metaNodes.push(
      <Text key="otps" color={tokens.textSecondary}>
        {otpsText}
      </Text>,
    )
  }
  const metaGroup = !plan.metaVisible ? null : (
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
