
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

export type DialogExitState = ReturnType<typeof useExitOnCtrlCDWithKeybindings>

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
  useKeybinding(
    'confirm:no',
    () => {
      onCancel()
    },
    { context: 'Confirmation', isActive: isCancelActive },
  )
  const exitState = useExitOnCtrlCDWithKeybindings(
    undefined,
    () => isCancelActive,
  )
  const cancelKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')
  const elevate = useElevatedSurface()

  let guide: React.ReactNode = null
  if (!hideInputGuide) {
    guide = (
      <Box marginTop={1}>
        <Text italic dimColor>
          {exitState.pending ? (
            exitChordNoticeText(exitState.keyName)
          ) : inputGuide ? (
            inputGuide(exitState)
          ) : (
            <Byline>
              <Text italic dimColor>
                <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              </Text>
              <Text italic dimColor>
                <KeyboardShortcutHint shortcut={cancelKey} action="cancel" />
              </Text>
            </Byline>
          )}
        </Text>
      </Box>
    )
  }

  const content = (
    <Box flexDirection="column">
      <Text bold color={color}>
        {title}
      </Text>
      {subtitle !== undefined && subtitle !== '' && subtitle !== null ? (
        <Text dimColor>{subtitle}</Text>
      ) : null}
      <Box height={1} />
      {children}
      {guide}
    </Box>
  )

  if (hideBorder) return content

  return (
    <Box flexDirection="column" ref={elevate}>
      <Pane color={color}>{content}</Pane>
    </Box>
  )
}

export default Dialog
