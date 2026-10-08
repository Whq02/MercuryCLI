import * as React from 'react'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { DOMElement } from '../../ink.js'
import { Box, Text, useAnimationValue } from '../../ink.js'
import { nodeCache } from '../../ink/node-cache.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useIdleMotion } from '../../hooks/useIdleMotion.js'
import {
  critterGazeEnabled,
  gazeKeyForPointer,
} from '../../utils/cockpit/critterGaze.js'
import {
  getPointerCell,
  getPointerVersion,
  subscribePointerCell,
} from '../../utils/cockpit/pointerCell.js'
import {
  BREATH_BUCKETS,
  BREATH_TICK_MS,
  breathBucket,
  critterIdleTickMs,
  EYE_OPEN,
  EYE_SHUT,
  readCritterFrameKey,
} from '../../utils/cockpit/critterIdle.js'
import {
  critterLiveFrameKey,
  critterSleepMode,
  critterSleepSince,
  subscribeCritterSleep,
} from '../../utils/cockpit/critterSleep.js'
import { lerpHex } from '../../utils/theme.js'
import { effectiveSwayPhase, type ArtForm, type CritterDef } from '../../utils/cockpit/critterData.js'
import { FAINT, TEAL } from '../mercuryPalette.js'
import { CritterArt } from './CritterArt.js'

function useIdleAnimation<T extends string | number>(
  intervalMs: number | null,
  derive: (timeMs: number) => T,
): { animate: boolean; ref: unknown; value: T } {
  const animate =
    intervalMs !== null && !(getInitialSettings().view?.reducedMotion ?? false)
  const [ref, value] = useAnimationValue(animate ? intervalMs : null, derive)
  return { animate, ref, value }
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const EMPTY_KEY = (): string => ''

type CritterFrameState = {
  animate: boolean
  asleep: boolean
  pupil: string
  gazeKey: string
  swayPhase: number
  sleepPhase: number | null
  ref: (el: DOMElement | null) => void
}

function asleepFor(specimen: boolean): boolean {
  return critterSleepSince() !== 0 && (!specimen || critterSleepMode() === 'forced')
}

function useCritterFrame(def: CritterDef, form: ArtForm, specimen: boolean): CritterFrameState {
  useSyncExternalStore(subscribeCritterSleep, critterSleepSince, critterSleepSince)
  const asleep = asleepFor(specimen)
  const frameDerive = useCallback(() => {
    const key = critterLiveFrameKey()
    const sampled = readCritterFrameKey(key)
    return `${key[0] ?? ''}${effectiveSwayPhase(def, form, asleepFor(specimen), sampled.swayPhase)}${key[2] ?? ''}`
  }, [def, form, specimen])
  const motionLevel = useIdleMotion('critter')
  const { animate, ref, value: frameKey } = useIdleAnimation(critterIdleTickMs(motionLevel, asleep), frameDerive)
  const sampled = readCritterFrameKey(frameKey)
  const sleepPhase = asleep ? (sampled.sleepPhase ?? 0) : null
  const pupil = asleep ? EYE_SHUT : sampled.sleepPhase !== null ? EYE_OPEN : sampled.pupil
  const swayPhase = effectiveSwayPhase(def, form, asleep, sampled.swayPhase)

  const gazeGrid = form === 'square' ? def.squareDock : null
  const gazeOn = animate && !asleep && gazeGrid !== null && critterGazeEnabled()
  const boxRef = useRef<DOMElement | null>(null)
  const composedRef = useCallback(
    (el: DOMElement | null) => {
      boxRef.current = el
      ;(ref as (e: DOMElement | null) => void)(el)
    },
    [ref],
  )
  const prevGazeKeyRef = useRef('')
  const gazeSampleRef = useRef('')
  const getGazeSnapshot = useCallback((): string => {
    const pointer = getPointerCell()
    const rect = boxRef.current ? nodeCache.get(boxRef.current) : undefined
    const sample = `${getPointerVersion()}|${rect ? `${rect.x},${rect.y}` : '-'}`
    if (sample === gazeSampleRef.current) return prevGazeKeyRef.current
    let key = ''
    if (pointer && rect && gazeGrid) {
      const px = pointer.col - rect.x + 0.5
      const py = (pointer.row - rect.y) * 2 + 1
      key = gazeKeyForPointer(gazeGrid, px, py, prevGazeKeyRef.current)
    }
    gazeSampleRef.current = sample
    prevGazeKeyRef.current = key
    return key
  }, [gazeGrid])
  const gazeKey = useSyncExternalStore(
    gazeOn ? subscribePointerCell : NOOP_SUBSCRIBE,
    gazeOn ? getGazeSnapshot : EMPTY_KEY,
    EMPTY_KEY,
  )
  return { animate, asleep, pupil, gazeKey, swayPhase, sleepPhase, ref: composedRef }
}

export function AnimatedCritterArt({ def, chunky = false, mini = false, square = false, specimen = false, lineBg }: { def: CritterDef; chunky?: boolean; mini?: boolean; square?: boolean; specimen?: boolean; lineBg?: (line: number) => string | undefined }): React.ReactNode {
  const usingSquare = square && def.squareDock.length > 0
  const form: ArtForm = usingSquare ? 'square' : 'mini'
  const frame = useCritterFrame(def, form, specimen)
  const ground = lineBg !== undefined ? { lineBg } : {}
  if (!frame.animate) {
    return frame.asleep ? (
      <CritterArt def={def} pupil={EYE_SHUT} sleepPhase={2} chunky={chunky} mini={mini} square={square} {...ground} />
    ) : (
      <CritterArt def={def} chunky={chunky} mini={mini} square={square} {...ground} />
    )
  }
  return (
    <Box flexDirection="column" ref={frame.ref as never}>
      <CritterArt def={def} pupil={frame.pupil} gazeKey={frame.gazeKey} swayPhase={frame.swayPhase} sleepPhase={frame.sleepPhase} chunky={chunky} mini={mini} square={square} {...ground} />
    </Box>
  )
}

export function BreathingDot(): React.ReactNode {
  const motionLevel = useIdleMotion('critter')
  const { animate, ref, value: bucket } = useIdleAnimation(
    motionLevel === 'full' ? BREATH_TICK_MS : null,
    breathBucket,
  )
  if (!animate) return <Text color={TEAL}>●</Text>
  const color = lerpHex(FAINT, TEAL, 0.45 + 0.55 * (bucket / BREATH_BUCKETS))
  return (
    <Box ref={ref as never}>
      <Text color={color}>●</Text>
    </Box>
  )
}
