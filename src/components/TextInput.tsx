import chalk from 'chalk'
import React, { useContext, useRef, useState } from 'react'
import { useMeasure } from '../hooks/effects.js'
import { Box, measureElement, type DOMElement } from '../ink.js'
import { PopupFormContext } from '../context/popupFormContext.js'
import { BaseTextInput } from './BaseTextInput.js'
import { useTextInput } from '../hooks/useTextInput.js'
import { useBlink } from '../hooks/useBlink.js'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { colorize } from '../ink/colorize.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'
import { getTheme } from '../utils/theme.js'
import { color } from '../utils/color.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { notBuilt } from '../pi/holes.js'

type Props = BaseTextInputProps & {
  selectionRange?: () => { start: number; end: number } | null | undefined
  onSelectionConsumed?: () => void
  onBeforeRangeEdit?: () => void
  selectionHighlight?: { start: number; end: number } | null
  viewportStartRef?: React.MutableRefObject<number | undefined>
}

export default function TextInput(props: Props): React.ReactNode {
  return notBuilt('src/components/TextInput.tsx:27')
}
