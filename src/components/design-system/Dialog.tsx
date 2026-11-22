import React from 'react'
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js'
import { Box, Text } from '../../ink.js'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useElevatedSurface } from '../mercury-ui/useElevatedSurface.js'
import Byline from './Byline.js'
import Pane from './Pane.js'
import { notBuilt } from '../../pi/holes.js'

type DialogExitState = ReturnType<typeof useExitOnCtrlCDWithKeybindings>

export function Dialog(arg0: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
  onCancel: () => void
  color?: string
  hideInputGuide?: boolean
  hideBorder?: boolean
  inputGuide?: (exitState: DialogExitState) => React.ReactNode
  isCancelActive?: boolean
}): React.ReactNode {
  return notBuilt('src/components/design-system/Dialog.tsx:15')
}

export default Dialog
