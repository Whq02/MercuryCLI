import * as React from 'react'
import { stringWidth } from '../../ink/stringWidth.js'
import { Text, useTheme } from '../../ink.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import type { SpinnerMode } from '../../types/spinner.js'
import { STILL_WAITING_MAX_INTENSITY } from './useStalledAnimation.js'
import { interpolateColor, parseRGB, toRGBColor } from './utils.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type Props = Unbuilt

export function GlimmerMessage(arg0: Props): React.ReactNode {
  return notBuilt('src/components/Spinner/GlimmerMessage.tsx:20')
}
