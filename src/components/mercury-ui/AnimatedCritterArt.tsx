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

// ============================================================================
//  mercury-ui/AnimatedCritterArt — the home splash's LIVING mascot.
//
//  CritterArt is pure-from-def and draws a still crab. This wraps it with a calm
//  idle loop so the launch splash feels alive without ever touching the shared
//  `.art` grid: the only thing that changes per frame is the `pupil` GLYPH (the
//  same prop /critter pose-aiming already uses), so the shape, hues, eye-white,
//  and layout are byte-identical to the static frame — the crab just BLINKS. The
//  blink SCHEDULE + Mercury/env gate live in utils/cockpit/critterIdle (pure,
//  provable); this file is only the view + the prefersReducedMotion read.
//
//  Same viewport-pause contract as AnimatedAsterisk: the clock is wired onto the
//  outer Box via useAnimationFrame's ref, so whenever the mascot leaves the
//  viewport the animation AUTO-STOPS — no off-screen re-renders, no flicker.
//  (Load-bearing since persistent hero: the mascot stays MOUNTED
//  at the top of scrollback for the whole session — it blinks only while the
//  operator is actually looking at it.)
//
//  Gated two ways to the EXACT static frame (`<CritterArt def={def} />`):
//    • prefersReducedMotion      → respect the accessibility setting
//    • MERCURY_CRITTER_IDLE=0     → explicit opt-out
//  OFF on any of those ⇒ render-identical to today.
// ============================================================================

function useIdleAnimation<T extends string | number>(
  intervalMs: number,
  derive: (timeMs: number) => T,
  enabled = true,
): { animate: boolean; ref: unknown; value: T } {
  // The env gate re-reads LIVE on every render (hardening: a gate that
  // latches its flag at mount answers for the wrong world after the flag
  // flips; flagEnv is a cheap map read). prefersReducedMotion keeps the
  // mount-era initial-settings read the sibling AnimatedAsterisk documents —
  // an OS/a11y preference, not a runtime flag, and not in the settings store.
  // When off, useAnimationValue(null) keeps the clock dormant so hook order
  // stays stable.
  //
  // useAnimationValue (not useAnimationFrame): the idle home lives at ~21
  // commits/s when raw clock time is state — every tick composes a frame even
  // when the pupil/breath OUTPUT is unchanged (idle-damage forensics
  // Deriving inside the subscription commits only on output
  // EDGES: blink lids (~0.6/s) + breath bucket crossings (~4.3/s).
  const motionOk =
    critterIdleEnabled() && !(getInitialSettings().prefersReducedMotion ?? false)
  const animate = motionOk && enabled
  const [ref, value] = useAnimationValue(animate ? intervalMs : null, derive)
  return { animate, ref, value }
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const EMPTY_KEY = (): string => ''

export function AnimatedCritterArt({ def, chunky = false, hero = false, wide = false, mini = false, square = false, specimen = false, lineBg }: { def: CritterDef; chunky?: boolean; hero?: boolean; wide?: boolean; mini?: boolean; /** THE SQUARE TIER (chat-feel item 5): the small berths' geometric form —
   *  hero-class eyes, so the GAZE tracks on it exactly like the hero (the
   *  same one-source law over the square grid's clusters), the blink lids
   *  through the same transform, and the body holds still. */
  square?: boolean; /** A SPECIMEN display — the /critter picker's cards, the onboarding
   *  fitting, the Concourse resident: surfaces whose job is showing the
   *  creature itself, not the session's working state. A specimen never
   *  wears the LIVE sleep verdict (under the agent predicate a quiet
   *  picker would otherwise show four sleeping cards — the one thing a
   *  chooser cannot judge a companion by); the FORCED capture gate still
   *  wins — see the verdict read below. */
  specimen?: boolean; lineBg?: (line: number) => string | undefined }): React.ReactNode {
  // SLEEP a store read, not a timer. The verdict changes on a real
  // turn edge or agent-lifecycle event (push — the wake is instant) or on the
  // shared 30s elapse bucket; this subscription is what tears the whole thing
  // down again when the last critter surface unmounts.
  useSyncExternalStore(subscribeCritterSleep, critterSleepSince, critterSleepSince)
  // A specimen vetoes the LIVE verdict only — the FORCED gate
  // (MERCURY_CRITTER_SLEEP=1) still wins, because that gate exists exactly so
  // captures and provers can put the sleeping frame on screen, and the state
  // matrix's one all-creatures surface is the /critter picker: specimen in
  // live use, the sleep gallery under the forced flag.
  const asleep =
    critterSleepSince() !== 0 && (!specimen || critterSleepMode() === 'forced')
  // The AUTHORED hero grids blink: the closed-lid pupil signal maps to the
  // pure heroBlinkRows transform (eye cream/pupil → mid shade), so a blink
  // edge changes REAL pixels. CritterArt's memo bails on every tick where the
  // pupil glyph did not flip, so the terminal repaints exactly TWO frames per
  // blink cycle (lid down, lid up) — a blink, not flicker. wide/chunky/flat
  // paths all share the same schedule.
  // ONE subscription for every moving part the packed frame key
  // carries pupil + sway phase + Zzz phase, so blinking, flowing and sleeping
  // share a single clock and a single viewport-pause ref — the ref
  // useAnimationValue returns is what gates the animation, and only one ref
  // can own the box. Asleep the cadence drops to the Zzz tick: nothing on a
  // sleeping critter moves fast enough to need 12 samples a second.
  //
  // The derive is the STORE-OWNED critterLiveFrameKey, and deliberately
  // ignores the ink clock's argument: that clock counts ms since the
  // process's first animation, while the sleep store stamps its anchor and
  // sleepSince in EPOCH ms — a derive on the mismatched base would pin
  // `time - sleepSince` at zero (the sleep glyphs frozen on their first
  // phase, a woken critter's sway held at the stamped anchor). The store's
  // key reads one time base end to end; the shared clock keeps its real job
  // — pacing WHEN the derive samples and pausing it off-viewport.
  //
  // The COMMITTED value is the key FOLDED onto the sway phase this mount's
  // frame actually reads (effectiveSwayPhase — the form mirrors CritterArt's
  // own decision): a still critter's frame reads none of the sway digit, a
  // settling one reads only whether the offset is positive, a sleeping pose
  // reads the breath's parity. The clock's sway digit advances for every
  // critter, so without the fold every step committed a frame that painted
  // the same cells. The RAW key rides a ref the same derive writes, so a
  // render reads exactly the key the clock last sampled — the same key an
  // unfolded value would carry — and the fold is dedup only.
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
  // Verdict-edge reconciliation: the packed key refreshes on the NEXT
  // clock tick after a flip, so for up to one tick it describes the OLD
  // verdict. The store's verdict wins in that window: a just-slept critter
  // paints the onset frame (lid + first z — exactly what the fresh derive
  // returns) and a just-woken one opens its eyes immediately instead of
  // holding a stale lid for a beat.
  const raw = readCritterFrameKey(rawKeyRef.current || frameKey)
  const sleepPhase = asleep ? (raw.sleepPhase ?? 0) : null
  const pupil = asleep ? EYE_SHUT : raw.sleepPhase !== null ? EYE_OPEN : raw.pupil
  const swayPhase = effectiveSwayPhase(def, form, asleep, raw.swayPhase)
  // MOUSE GAZE: the pupils track the terminal pointer.
  // Gated like the blink (animate = MERCURY_CRITTER_IDLE + reduced
  // motion) PLUS its own critterGazeEnabled() (MERCURY_CRITTER_GAZE=0 kills;
  // captures pin it off in renderScenarios) — and it exists on the grids
  // whose eyes carry the hero-class E/K clusters: the authored hero grids
  // AND the square tier (the small berths' eyes follow under the same one-
  // source law). All hooks run unconditionally (order stability);
  // when the gate is off the subscription is a no-op and the key is ''.
  // …and never while ASLEEP: a shut lid cannot track a pointer, and leaving
  // the gaze armed would also keep the pointer store's subscription live for a
  // creature that is not looking at anything.
  const gazeGrid = usingHero ? def.heroArt! : usingSquare ? def.square : null
  const gazeOn = animate && !asleep && gazeGrid !== null && critterGazeEnabled()
  // The rendered box's screen rect (nodeCache — the same scroll-adjusted
  // source hit-testing uses) maps the pointer's screen cell into ART pixels:
  // one terminal column = one art column (×2 when wide), one terminal row =
  // TWO art rows (the half-block pairing), origin at the content-bounds
  // slice. A missing rect (first frame, culled offscreen) reads as neutral.
  const boxRef = useRef<DOMElement | null>(null)
  const composedRef = useCallback(
    (el: DOMElement | null) => {
      boxRef.current = el
      ;(ref as (e: DOMElement | null) => void)(el)
    },
    [ref],
  )
  // The subscription's SNAPSHOT is the derived gaze key, not the raw pointer
  // cell: a pointer sweeping the transcript crosses dozens
  // of cells a second, but each eye only has ~6 cells to aim at — deriving in
  // the snapshot means this component commits on real PUPIL edges only, and
  // the far-from-the-mascot sweep costs zero renders. The previous key feeds
  // the face-level hysteresis AND the one-step walk (the gaze law's sweep
  // adjacency: gazeKeyForPointer advances at most one cell per derived key).
  // The SAMPLE GUARD keys that step to the pointer store's version plus the
  // rect the mapping read: React's repeated snapshot calls inside a settled
  // world replay the SAME key (useSyncExternalStore's contract) instead of
  // walking the pupils ahead of the pointer, and each real pointer edge —
  // SGR motion streams report every cell crossed — advances exactly one
  // step. The ~6s idle walk-home still lands — the pointer store emits it
  // and the snapshot steps home to '' (rest sits one step from every offset
  // the pool authors; the census pins that fact).
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
      // The hero renders content-sliced, so its art origin sits cStart
      // columns into the grid; the square renders WHOLE, so its origin is
      // the grid's own column 0.
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
  // Static fallback: the EXACT tree MercuryHome rendered before (no wrapper Box,
  // default pupil) ⇒ render byte-identical when off / on the hero grid.
  //
  // …EXCEPT that a critter which is genuinely asleep still LOOKS asleep here.
  // Reduced motion (and an off-screen or motion-parked mount) suppresses the
  // ANIMATION, not the state: the lid is shut and the Zzz sits at its full
  // phase, held still. Suppressing the state instead would make a reduced-motion
  // operator's idle session indistinguishable from a working one — the same
  // honesty rule the rest of the live-glyph grammar follows.
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

// A gently breathing status dot for the `● ready` line — pulses within the upper
// teal range (never fully fades) so the splash reads as alive-and-idle. lerpHex
// interpolates existing tokens (no new hex). Inline-safe: a 1-cell Box so it can
// carry the viewport-pause ref while sitting in the row beside " ready".
export function BreathingDot(): React.ReactNode {
  const { animate, ref, value: bucket } = useIdleAnimation(BREATH_TICK_MS, breathBucket)
  if (!animate) return <Text color={TEAL}>●</Text>
  const color = lerpHex(FAINT, TEAL, 0.45 + 0.55 * (bucket / BREATH_BUCKETS)) // dim-teal to full teal
  return (
    <Box ref={ref as never}>
      <Text color={color}>●</Text>
    </Box>
  )
}
