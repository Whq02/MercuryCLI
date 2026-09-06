import * as React from 'react'
import { Text, useAnimationValue } from '../../ink.js'
import { useIdleMotion } from '../../hooks/useIdleMotion.js'
import { useSettingsMaybe } from '../../hooks/useSettings.js'
import { useTypingPause } from '../../hooks/useTypingPause.js'
import { lerpHex } from '../../utils/theme.js'
import {
  ATTENTION_BUCKETS,
  ATTENTION_TICK_MS,
  attentionBucket,
  glyphTickMs,
  READY_BUCKETS,
  READY_TICK_MS,
  readyBucket,
  SETTLE_MS,
  TWINKLE_TICK_MS,
  twinkleBright,
  WORK_TICK_MS,
  workGlyphForTime,
} from '../../utils/cockpit/liveGlyphs.js'
import { AMBER, FAINT, IVORY } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { GLYPH } from './glyphs.js'


export function WorkingGlyph({
  color,
  active = true,
  tickMs = WORK_TICK_MS,
}: {
  color: string
  active?: boolean
  tickMs?: number
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const tick = glyphTickMs(useIdleMotion('glyphs'), tickMs)
  const animate = active && !reducedMotion && tick !== null
  const sampleMs = tick ?? tickMs
  const [, glyph] = useAnimationValue(animate ? sampleMs : null, time =>
    workGlyphForTime((time * WORK_TICK_MS) / sampleMs),
  )
  return <Text color={color}>{animate ? glyph : GLYPH.inProgress}</Text>
}

export function AttentionPulse({
  children,
  active = true,
  bold = false,
}: {
  children: React.ReactNode
  active?: boolean
  bold?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const tick = glyphTickMs(useIdleMotion('glyphs'), ATTENTION_TICK_MS)
  const animate = active && !reducedMotion && tick !== null
  const [, bucket] = useAnimationValue(animate ? tick : null, attentionBucket)
  const color = animate ? lerpHex(FAINT, AMBER, bucket / ATTENTION_BUCKETS) : AMBER
  return (
    <Text bold={bold} color={color}>
      {children}
    </Text>
  )
}

const VALUE_GLOW_MS = 900

export function ValueGlow({
  value,
  color,
  children,
  ms = VALUE_GLOW_MS,
}: {
  value: unknown
  color: string
  children: React.ReactNode
  ms?: number
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const enabled = !reducedMotion && useIdleMotion('glyphs') !== 'off'
  const prevRef = React.useRef(value)
  const [glowing, setGlowing] = React.useState(false)
  React.useEffect(() => {
    if (Object.is(prevRef.current, value)) {
      setGlowing(false)
      return
    }
    prevRef.current = value
    if (!enabled) {
      setGlowing(false)
      return
    }
    setGlowing(true)
    const t = setTimeout(() => setGlowing(false), ms)
    return () => clearTimeout(t)
  }, [value, enabled, ms])
  return (
    <Text bold={glowing} color={glowing ? IVORY : color}>
      {children}
    </Text>
  )
}

export function ReadyBreath({
  deep,
  to,
  children,
  active = true,
  dim = false,
}: {
  deep: string
  to: string
  children: React.ReactNode
  active?: boolean
  dim?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const typing = useTypingPause()
  const tick = glyphTickMs(useIdleMotion('glyphs'), READY_TICK_MS)
  const animate = active && !reducedMotion && !typing && tick !== null
  const [, bucket] = useAnimationValue(animate ? tick : null, readyBucket)
  const color = animate ? lerpHex(deep, to, bucket / READY_BUCKETS) : to
  return (
    <Text color={color} dimColor={dim}>
      {children}
    </Text>
  )
}

export function TwinkleSpark({
  color,
  active = true,
}: {
  color: string
  active?: boolean
}): React.ReactNode {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const { accentSoft } = useMercuryTokens()
  const typing = useTypingPause()
  const tick = glyphTickMs(useIdleMotion('glyphs'), TWINKLE_TICK_MS)
  const animate = active && !reducedMotion && !typing && tick !== null
  const [, bright] = useAnimationValue(animate ? tick : null, twinkleBright)
  const glint = animate && bright
  return <Text color={glint ? accentSoft : color}>{glint ? GLYPH.sparkBright : GLYPH.spark}</Text>
}

export function useSettleFlash(settled: boolean): boolean {
  const reducedMotion = useSettingsMaybe()?.prefersReducedMotion ?? false
  const enabled = !reducedMotion && useIdleMotion('glyphs') !== 'off'
  const prevRef = React.useRef(settled)
  const [flash, setFlash] = React.useState(false)
  React.useEffect(() => {
    const was = prevRef.current
    prevRef.current = settled
    if (!enabled || was || !settled) {
      setFlash(false)
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), SETTLE_MS)
    return () => clearTimeout(t)
  }, [settled, enabled])
  return flash
}

export const CURSOR_NUDGE_MS = 380

export function CursorCell({
  focused,
  color,
}: {
  focused: boolean
  color: string
}): React.ReactNode {
  return (
    <ValueGlow value={focused} color={color} ms={CURSOR_NUDGE_MS}>
      {focused ? `${GLYPH.cursor} ` : '  '}
    </ValueGlow>
  )
}
