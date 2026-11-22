import React, { useState } from 'react'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { Box, Text } from '../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { Select } from './CustomSelect/index.js'
import Byline from './design-system/Byline.js'
import Pane from './design-system/Pane.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type Props = Unbuilt

const OPTION_VALUES = { enabled: 'true', disabled: 'false' } as const

export function ThinkingToggle(arg0: Props): React.ReactNode {
  return notBuilt('src/components/ThinkingToggle.tsx:21')
}

export default ThinkingToggle
