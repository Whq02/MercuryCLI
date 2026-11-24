import React from 'react'
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js'
import { Box, Text } from '../themedRenderer.js'
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import { useExitChord } from '../keys/useExitChord.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { useElevatedSurface } from '../widgets/useElevatedSurface.js'
import { Byline } from './Byline.js'
import { Pane } from './Pane.js'

type DialogExitState = ReturnType<typeof useExitChord>

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
  const exitState = useExitChord(undefined, () => isCancelActive)
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
