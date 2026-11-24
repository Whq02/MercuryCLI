import * as React from 'react'
import { stringWidth } from '../renderer/stringWidth.js'
import { Text, useTheme } from '../themedRenderer.js'
import { getGraphemeSegmenter } from '../../platform/text/textSegments.js'
import { getTheme, type Theme } from '../theme/theme.js'
import type { SpinnerMode } from './spinnerMode.js'
import { STILL_WAITING_MAX_INTENSITY } from './useStalledAnimation.js'
import { interpolateColor, parseRGB, toRGBColor } from './glyphsAndColors.js'

type Props = {
  flashOpacity: number
  shimmerIndex: number
  message: string
  messageColor: keyof Theme & string
  mode: SpinnerMode
  shimmerColor: keyof Theme & string
  attentionIntensity?: number
}

export function ShimmerMessage({ flashOpacity, shimmerIndex, message, messageColor, mode, shimmerColor, attentionIntensity = 0 }: Props): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  if (message === '') return null

  let color: string = messageColor
  let spaceColor: string = messageColor
  let content: React.ReactNode = message
  const attention = attentionIntensity > 0
  if (attention || mode === 'tool-use') {
    const target = attention ? 'warning' : shimmerColor
    const base = parseRGB(theme[messageColor] ?? '')
    const accent = parseRGB(theme[target] ?? '')
    if (base && accent) color = toRGBColor(interpolateColor(base, accent, attention ? attentionIntensity : flashOpacity))
    else if (attention ? attentionIntensity >= STILL_WAITING_MAX_INTENSITY / 2 : flashOpacity > 0.5) color = target
    if (attention) spaceColor = color
  } else {
    const first = shimmerIndex - 1
    const last = shimmerIndex + 1
    if (first < stringWidth(message) && last >= 0) {
      let before = '', shimmer = '', after = ''
      let column = 0
      for (const { segment } of getGraphemeSegmenter().segment(message)) {
        const end = column + stringWidth(segment)
        if (end <= Math.max(0, first)) before += segment
        else if (column > last) after += segment
        else shimmer += segment
        column = end
      }
      content = <>{before}<Text color={shimmerColor}>{shimmer}</Text>{after}</>
    }
  }
  return <><Text color={color}>{content}</Text><Text color={spaceColor}> </Text></>
}
