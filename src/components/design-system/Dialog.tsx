// Titled confirm/cancel shell: bold title in the role colour, optional
// dimmed subtitle, one blank row, the children, and an input guide inside a
// single italic dimmed text node (so a caller-supplied guide inherits the
// styling). Frames through Pane and registers the pane's rectangle as an
// elevated surface so the compositor pushes everything else into the
// background while the dialog is up; the wrapper carrying the registration
// is geometry-neutral.

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
  /** Custom guide renderer; receives the ctrl+C/D exit state. */
  inputGuide?: (exitState: DialogExitState) => React.ReactNode
  /** A caller hosting a text field turns this off while the field has
   *  focus, so escape and the exit chords reach the field instead. */
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
            // C13: the exit sentence has ONE owner (ExitChordNotice) — this
            // was one of the divergent spellings.
            exitChordNoticeText(exitState.keyName)
          ) : inputGuide ? (
            inputGuide(exitState)
          ) : (
            // The kit's ONE hint grammar (KeyboardShortcutHint — '↵ confirm'
            // / 'esc cancel'): this shared default reaches 23 dialogs, and
            // the hand-built sentence here was a third grammar the design
            // system had already retired.
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
