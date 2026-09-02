import * as React from 'react'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { DOMElement } from '../../ink.js'
import { Box, Text, useAnimationValue } from '../../ink.js'
import { nodeCache } from '../../ink/node-cache.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
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
  critterIdleEnabled,
  EYE_OPEN,
  EYE_SHUT,
  IDLE_TICK_MS,
  readCritterFrameKey,
  SLEEP_TICK_MS,
} from '../../utils/cockpit/critterIdle.js'
import {
  critterLiveFrameKey,
  critterSleepMode,
  critterSleepSince,
  subscribeCritterSleep,
} from '../../utils/cockpit/critterSleep.js'
import { lerpHex } from '../../utils/theme.js'
import { effectiveSwayPhase, heroContentBounds, type CritterDef } from '../../utils/cockpit/critterData.js'
import { FAINT, TEAL } from '../mercuryPalette.js'
import { CritterArt } from './CritterArt.js'


function useIdleAnimation<T extends string | number>(
  intervalMs: number,
  derive: (timeMs: number) => T,
  enabled = true,
): { animate: boolean; ref: unknown; value: T } {
  const motionOk =
    critterIdleEnabled() && !(getInitialSettings().prefersReducedMotion ?? false)
  const animate = motionOk && enabled
  const [ref, value] = useAnimationValue(animate ? intervalMs : null, derive)
  return { animate, ref, value }
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const EMPTY_KEY = (): string => ''

export function AnimatedCritterArt({ def, chunky = false, hero = false, wide = false, mini = false, square = false, specimen = false, lineBg }: { def: CritterDef; chunky?: boolean; hero?: boolean; wide?: boolean; mini?: boolean;
  square?: boolean;
  specimen?: boolean; lineBg?: (line: number) => string | undefined }): React.ReactNode {
  useSyncExternalStore(subscribeCritterSleep, critterSleepSince, critterSleepSince)
  const asleep =
    critterSleepSince() !== 0 && (!specimen || critterSleepMode() === 'forced')
  const usingHero = hero && !!def.heroArt && def.heroArt.length > 0
  const usingSquare = !usingHero && square && !!def.square && def.square.length > 0
  const form = usingHero ? 'hero' : usingSquare ? 'square' : mini ? 'mini' : 'art'
  const rawKeyRef = useRef('')
  const frameDerive = useCallback(() => {
    const key = critterLiveFrameKey()
    rawKeyRef.current = key
    const sampled = readCritterFrameKey(key)
    const asleepNow = critterSleepSince() !== 0 && (!specimen || critterSleepMode() === 'forced')
    return `${key[0] ?? ''}${effectiveSwayPhase(def, form, asleepNow, sampled.swayPhase)}${key[2] ?? ''}`
  }, [def, form, specimen])
  const { animate, ref, value: frameKey } = useIdleAnimation(
    asleep ? SLEEP_TICK_MS : IDLE_TICK_MS,
    frameDerive,
    true,
  )
  const raw = readCritterFrameKey(rawKeyRef.current || frameKey)
  const sleepPhase = asleep ? (raw.sleepPhase ?? 0) : null
  const pupil = asleep ? EYE_SHUT : raw.sleepPhase !== null ? EYE_OPEN : raw.pupil
  const swayPhase = effectiveSwayPhase(def, form, asleep, raw.swayPhase)
  const gazeGrid = usingHero ? def.heroArt! : usingSquare ? def.square : null
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
    const grid = usingHero ? def.heroArt : usingSquare ? def.square : undefined
    const pointer = getPointerCell()
    const rect = boxRef.current ? nodeCache.get(boxRef.current) : undefined
    const sample = `${getPointerVersion()}|${rect ? `${rect.x},${rect.y}` : '-'}`
    if (sample === gazeSampleRef.current) return prevGazeKeyRef.current
    let key = ''
    if (pointer && rect && grid) {
      const dup = usingHero && wide ? 2 : 1
      const [cStart] = usingHero ? heroContentBounds(grid) : [0]
      const px = cStart + (pointer.col - rect.x) / dup + 0.5
      const py = (pointer.row - rect.y) * 2 + 1
      key = gazeKeyForPointer(grid, px, py, prevGazeKeyRef.current)
    }
    gazeSampleRef.current = sample
    prevGazeKeyRef.current = key
    return key
  }, [wide, def, usingHero, usingSquare])
  const gazeKey = useSyncExternalStore(
    gazeOn ? subscribePointerCell : NOOP_SUBSCRIBE,
    gazeOn ? getGazeSnapshot : EMPTY_KEY,
    EMPTY_KEY,
  )
  if (!animate) {
    return asleep ? (
      <CritterArt def={def} pupil={EYE_SHUT} sleepPhase={2} chunky={chunky} hero={hero} wide={wide} mini={mini} square={square} {...(lineBg !== undefined ? { lineBg } : {})} />
    ) : (
      <CritterArt def={def} chunky={chunky} hero={hero} wide={wide} mini={mini} square={square} {...(lineBg !== undefined ? { lineBg } : {})} />
    )
  }
  return (
    <Box flexDirection="column" ref={composedRef as never}>
      <CritterArt def={def} pupil={pupil} gazeKey={gazeKey} swayPhase={swayPhase} sleepPhase={sleepPhase} chunky={chunky} hero={hero} wide={wide} mini={mini} square={square} {...(lineBg !== undefined ? { lineBg } : {})} />
    </Box>
  )
}

export function BreathingDot(): React.ReactNode {
  const { animate, ref, value: bucket } = useIdleAnimation(BREATH_TICK_MS, breathBucket)
  if (!animate) return <Text color={TEAL}>●</Text>
  const color = lerpHex(FAINT, TEAL, 0.45 + 0.55 * (bucket / BREATH_BUCKETS))
  return (
    <Box ref={ref as never}>
      <Text color={color}>●</Text>
    </Box>
  )
}
