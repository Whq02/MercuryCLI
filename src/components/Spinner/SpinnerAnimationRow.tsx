import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { useAnimationValue } from '../../ink/hooks/use-animation-value.js'
import type { Theme } from '../../utils/theme.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { FOCAL_TICK_MS, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { GLYPH } from '../../utils/glyphs.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import { getEphemeralProgressFrame, useEphemeralProgressVersion } from '../../state/ephemeralProgressStore.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { useShimmerAnimation } from './useShimmerAnimation.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { useOutputRate } from './useOutputRate.js'
import { isQuicksilverLine } from '../../constants/spinnerVerbs.js'
import type { SpinnerMode } from '../../types/spinner.js'
import type { LiveTurnFactsV1 } from '../../services/engine-connector/seatLive.js'
import { liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './liveCounterWords.js'
import { turnStripLines } from './stripHeight.js'
import { planSpinnerHud } from './spinnerHud.js'
import { anchoredElapsedMs, anchorSeatClock, type SeatClockAnchor } from './seatClock.js'

const SLOW_TICK_MS = WORK_TICK_MS * 2

type SpinnerAnimationRowProps = {
  activeToolCount: number
  columns: number
  effortSuffix?: string
  hookWaitKeys?: readonly string[]
  inWorkCapsule?: boolean
  liveTurnFactsRef?: React.RefObject<LiveTurnFactsV1>
  loadingStartTimeRef: React.RefObject<number>
  message: string
  messageColor: keyof Theme & string
  mode: SpinnerMode
  outputTokensRef?: React.RefObject<number | null>
  overrideColor: (keyof Theme & string) | null
  pauseStartTimeRef: React.RefObject<number | null>
  reducedMotion: boolean
  responseLengthRef: React.RefObject<number>
  shimmerColor: keyof Theme & string
  spinnerSuffix?: string | null
  still?: boolean
  totalPausedMsRef: React.RefObject<number>
  verbose: boolean
}

const NO_KEYS: readonly string[] = []

export function SpinnerAnimationRow(props: SpinnerAnimationRowProps): React.ReactNode {
  const {
    columns, hookWaitKeys = NO_KEYS, inWorkCapsule = false, liveTurnFactsRef, loadingStartTimeRef,
    message, messageColor, mode, outputTokensRef, overrideColor, pauseStartTimeRef, reducedMotion,
    responseLengthRef, shimmerColor, spinnerSuffix, still = false, totalPausedMsRef, verbose,
  } = props
  const now = Date.now()
  if (loadingStartTimeRef.current === 0) loadingStartTimeRef.current = now
  const start = loadingStartTimeRef.current
  const paused = totalPausedMsRef.current
  const held = pauseStartTimeRef.current === null ? 0 : now - pauseStartTimeRef.current
  const anchor = useRef<SeatClockAnchor | null>(null)
  anchor.current = anchorSeatClock(anchor.current, start, paused)
  const effectiveElapsedMs = Math.max(0, now - start - paused - held, anchoredElapsedMs(anchor.current, now, held))

  const [glyphRef, workTime] = useAnimationValue(reducedMotion ? null : WORK_TICK_MS, t => t)
  const [, focalTime] = useAnimationValue(!reducedMotion && mode === 'requesting' ? FOCAL_TICK_MS : null, t => t)
  const [, slowTime] = useAnimationValue(reducedMotion ? null : SLOW_TICK_MS, t => t)
  useAnimationValue(reducedMotion ? null : FOCAL_TICK_MS, () => responseLengthRef.current ?? 0)
  const time = Math.max(workTime, focalTime, slowTime)
  const currentResponseLength = responseLengthRef.current ?? 0
  const { attentionIntensity, stillWaiting } = useStalledAnimation(time, {
    currentResponseLength, mode, reducedMotion, suppressed: overrideColor !== null,
  })
  const facts = liveTurnFactsRef?.current ?? turnFactsOfRefs(currentResponseLength, outputTokensRef?.current ?? null)
  const liveWords = liveCounterWords({ ...facts, phase: liveCounterPhaseOf(mode), sentAtMs: now - effectiveElapsedMs }, now)
  const otps = useOutputRate(
    liveTurnFactsRef?.current.replyChars ?? currentResponseLength,
    !reducedMotion && !still && pauseStartTimeRef.current === null && liveWords.promise === null && (mode === 'responding' || mode === 'tool-input'),
    now,
  )
  useEphemeralProgressVersion(hookWaitKeys)
  const suffixText = spinnerSuffix ?? hookWaitLineOf(hookWaitKeys.map(getEphemeralProgressFrame)) ?? ''
  const wasStacked = useRef(false)
  const plan = planSpinnerHud({
    columns, message, mode, still, verbose, effectiveElapsedMs, liveWords, otps, suffixText, wasStacked: wasStacked.current,
  }, wanted => turnStripLines(start, wanted))
  wasStacked.current = plan.stacked
  const [messageRef, glimmerIndex] = useShimmerAnimation(mode, message, stillWaiting)
  const { textSecondary } = useMercuryTokens()

  const color = overrideColor ?? messageColor
  const attention = overrideColor !== null ? 0 : attentionIntensity
  const cadence = isQuicksilverLine(message.split(' · ', 1)[0]!.replace(/…\s*$/, '').trim()) ? 'quicksilver' : 'standard'
  const frame = Math.floor(time / WORK_TICK_MS)
  const flash = mode === 'tool-use' && !reducedMotion ? (1 + Math.sin(slowTime / 2000 * 2 * Math.PI)) / 2 : 0
  const figures = plan.metaVisible && (
    <Text dimColor>
      ({plan.ordered.map(({ key, text }, index) => <Text key={key}>{index > 0 ? ' · ' : ''}{text}</Text>)}
      {plan.showOtps && <>{plan.ordered.length > 0 ? ' · ' : ''}<Text color={textSecondary}>{plan.otpsText}</Text></>})
    </Text>
  )
  const suffix = suffixText !== '' && (
    <Text dimColor>{plan.secondRow ? '' : '· '}{suffixText}{plan.metaVisible ? ' ' : ''}</Text>
  )
  return (
    <Box flexDirection="column" width="100%" marginTop={inWorkCapsule ? 0 : 1}>
      <Box width="100%">
        {still ? (
          <Box ref={glyphRef} width={2} height={1} flexWrap="wrap"><Text color={color}>{GLYPH.spark}</Text></Box>
        ) : (
          <Box ref={glyphRef}>
            <SpinnerGlyph attentionIntensity={attention} cadence={cadence} frame={frame} messageColor={color} reducedMotion={reducedMotion} time={time} />
          </Box>
        )}
        <Box ref={messageRef}>
          {still ? <Text color={color}>{message}</Text> : (
            <GlimmerMessage attentionIntensity={attention} flashOpacity={flash} glimmerIndex={glimmerIndex} message={message} messageColor={color} mode={mode} shimmerColor={overrideColor ?? shimmerColor} />
          )}
        </Box>
        {plan.segBVisible && !plan.secondRow && <Text>{suffix}{figures}</Text>}
      </Box>
      {plan.secondRow && (
        <Box height={1} width="100%">
          {plan.segBVisible && <Text wrap="truncate-end">{suffix}{figures}</Text>}
        </Box>
      )}
    </Box>
  )
}
