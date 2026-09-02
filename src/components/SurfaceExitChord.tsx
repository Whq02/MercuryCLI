
import React from 'react'
import { Box, useInput } from '../ink.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from '../hooks/useDoublePress.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { ExitChordNotice, exitChordNoticeText } from './PromptInput/ExitChordNotice.js'

const NOTICE_INDENT = 2

export function SurfaceExitChord({ onPendingChange }: { onPendingChange: (pending: boolean) => void }): null {
  const press = useDoublePress(
    onPendingChange,
    () => {
      void gracefulShutdown(0, 'prompt_input_exit')
    },
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )
  useInput((input, key) => {
    if (key.ctrl && input === 'c') press()
  })
  return null
}

export function SurfaceExitChordNotice({ pending }: { pending: boolean }): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  if (!pending) return null
  const width = Math.min(columns, NOTICE_INDENT + exitChordNoticeText('Ctrl-C').length)
  return (
    <Box
      position="absolute"
      top={Math.max(0, rows - 1)}
      left={0}
      width={width}
      height={1}
      paddingLeft={NOTICE_INDENT}
      overflow="hidden"
      opaque={true}
    >
      <ExitChordNotice keyName="Ctrl-C" />
    </Box>
  )
}
