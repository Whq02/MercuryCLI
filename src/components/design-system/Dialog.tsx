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

type DialogExitState = ReturnType<typeof useExitOnCtrlCDWithKeybindings>

export function Dialog({
  title,
  subtitle,
  children,
  onCancel,
  color = 'permission',
  hideInputGuide = false,
  hideBorder = false,
  inputGuide,
  isCancelActive = true,
}: {
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
  const elevatedRef = useElevatedSurface()
  const exitState = useExitOnCtrlCDWithKeybindings(undefined, () => isCancelActive)
  useKeybinding('confirm:no', () => onCancel(), {
    context: 'Confirmation',
    isActive: isCancelActive,
  })
  const cancelShortcut = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')

  const hasSubtitle =
    subtitle !== undefined && subtitle !== null && subtitle !== ''

  const guide = hideInputGuide ? null : (
    <Box marginTop={1}>
      <Text dimColor italic>
        {exitState.pending ? (
          exitChordNoticeText(exitState.keyName)
        ) : inputGuide ? (
          inputGuide(exitState)
        ) : (
          <Byline>
            {'↑↓ move · pgup/pgdn page'}
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <KeyboardShortcutHint shortcut={cancelShortcut} action="cancel" />
          </Byline>
        )}
      </Text>
    </Box>
  )

  const content = (
    <Box flexDirection="column">
      <Text bold color={color}>
        {title}
      </Text>
      {hasSubtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Box height={1} />
      {children}
      {guide}
    </Box>
  )

  if (hideBorder) return content

  return (
    <Box ref={elevatedRef} flexDirection="column">
      <Pane color={color}>{content}</Pane>
    </Box>
  )
}

export default Dialog
