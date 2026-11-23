import * as React from 'react'
import { Box, Text, useTheme } from '../themedRenderer.js'
import { getTheme, type Theme } from '../theme/theme.js'
import { STILL_WAITING_MAX_INTENSITY } from './useStalledAnimation.js'
import { getDefaultCharacters, interpolateColor, parseRGB, toRGBColor } from './glyphsAndColors.js'

type Cadence = 'standard' | 'quicksilver'

type Props = {
  messageColor: keyof Theme & string
  frame: number
  cadence?: Cadence
  attentionIntensity?: number
  time?: number
  reducedMotion?: boolean
}

const FORWARD = getDefaultCharacters()
const FRAMES = FORWARD.concat(FORWARD.toReversed())
const REDUCED_MOTION_HALF_BREATH_MS = 1000
const QUICKSILVER_SWING = [0, 0, 1, 2, 2, 3, 4, 5] as const
const QUICKSILVER_BAR_ADVANCE = 6

const swung = (frame: number): number =>
  Math.floor(frame / QUICKSILVER_SWING.length) * QUICKSILVER_BAR_ADVANCE + QUICKSILVER_SWING[frame % QUICKSILVER_SWING.length]!

const glyphAt = (frame: number, cadence: Cadence): string => {
  const index = cadence === 'quicksilver' ? swung(frame) : frame
  return FRAMES[index % FRAMES.length]!
}

function attentionColor(theme: Theme, messageColor: keyof Theme, intensity: number): string {
  const base = theme[messageColor]
  const baseRGB = base ? parseRGB(base) : null
  const warningRGB = parseRGB(theme.warning)
  if (baseRGB && warningRGB) return toRGBColor(interpolateColor(baseRGB, warningRGB, intensity))
  return intensity >= STILL_WAITING_MAX_INTENSITY / 2 ? 'warning' : messageColor
}

function Cell({ color, dim = false, children }: { color: string; dim?: boolean; children: string }): React.ReactNode {
  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={color} dimColor={dim}>
        {children}
      </Text>
    </Box>
  )
}

export function SpinnerGlyph({ messageColor, frame, cadence = 'standard', attentionIntensity = 0, time = 0, reducedMotion = false }: Props): React.ReactNode {
  const [themeName] = useTheme()
  if (reducedMotion) {
    const dim = Math.floor(time / REDUCED_MOTION_HALF_BREATH_MS) % 2 !== 0
    return <Cell color={messageColor} dim={dim}>●</Cell>
  }
  const color = attentionIntensity > 0 ? attentionColor(getTheme(themeName), messageColor, attentionIntensity) : messageColor
  return <Cell color={color}>{glyphAt(frame, cadence)}</Cell>
}
