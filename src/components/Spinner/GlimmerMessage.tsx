import * as React from 'react'
import { stringWidth } from '../../ink/stringWidth.js'
import { Text, useTheme } from '../../ink.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import type { SpinnerMode } from './types.js'
import { STILL_WAITING_MAX_INTENSITY } from './useStalledAnimation.js'
import { interpolateColor, parseRGB, toRGBColor } from './utils.js'

type Props = {
  message: string
  mode: SpinnerMode
  messageColor: keyof Theme
  glimmerIndex: number
  flashOpacity: number
  shimmerColor: keyof Theme
  /** the restrained "still waiting" ease toward the theme's
   *  AMBER attention role (same target as SpinnerGlyph, so the glyph and the
   *  verb warm to the SAME amber) — never CRIMSON. */
  attentionIntensity?: number
}

// Hand-written (no React-Compiler `_c` memo cache).
export function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
  attentionIntensity = 0,
}: Props): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)

  // This component re-renders at 20fps (glimmerIndex changes every 50ms) but
  // message is stable within a turn. Precompute grapheme segmentation + widths
  // once per message instead of per frame. Measured -81% on the shimmer path.
  const { segments, messageWidth } = React.useMemo(() => {
    const segs: { segment: string; width: number }[] = []
    for (const { segment } of getGraphemeSegmenter().segment(message)) {
      segs.push({ segment, width: stringWidth(segment) })
    }
    return { segments: segs, messageWidth: stringWidth(message) }
  }, [message])

  if (!message) return null

  // A real mid-stream gap warms the verb toward the AMBER attention role
  // restrained, never the failure red.
  if (attentionIntensity > 0) {
    const baseColorStr = theme[messageColor]
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null
    const attentionRGB = parseRGB(theme.warning)

    if (baseRGB && attentionRGB) {
      const interpolated = interpolateColor(baseRGB, attentionRGB, attentionIntensity)
      const color = toRGBColor(interpolated)
      return (
        <>
          <Text color={color}>{message}</Text>
          <Text color={color}> </Text>
        </>
      )
    }

    // Fallback for ANSI themes: flip to the plain warning role once the ease
    // passes its halfway point.
    const color =
      attentionIntensity >= STILL_WAITING_MAX_INTENSITY / 2 ? 'warning' : messageColor
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    )
  }

  // tool-use mode: all chars flash with the same opacity, so render as a
  // single <Text> instead of N individual per-char components (the retired
  // FlashingChar approach — deleted with the orphan burn-down).
  if (mode === 'tool-use') {
    const baseColorStr = theme[messageColor]
    const shimmerColorStr = theme[shimmerColor]
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null
    const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null

    if (baseRGB && shimmerRGB) {
      const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity)
      return (
        <>
          <Text color={toRGBColor(interpolated)}>{message}</Text>
          <Text color={messageColor}> </Text>
        </>
      )
    }

    const color = flashOpacity > 0.5 ? shimmerColor : messageColor
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  // Shimmer mode: only chars within ±1 of glimmerIndex need the shimmer
  // color. When glimmer is offscreen, render as a single <Text>.
  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  // Carve the string at visual-column boundaries into at most three runs.
  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shim = ''
  let after = ''
  for (const { segment, width } of segments) {
    if (colPos + width <= clampedStart) {
      before += segment
    } else if (colPos > shimmerEnd) {
      after += segment
    } else {
      shim += segment
    }
    colPos += width
  }

  return (
    <>
      {before && <Text color={messageColor}>{before}</Text>}
      <Text color={shimmerColor}>{shim}</Text>
      {after && <Text color={messageColor}>{after}</Text>}
      <Text color={messageColor}> </Text>
    </>
  )
}
