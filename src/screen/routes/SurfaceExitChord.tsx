
import React from 'react'
import { Box, useInput } from '../themedRenderer.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from '../keys/useDoublePress.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { gracefulShutdown } from '../../platform/processes/gracefulShutdown.js'
import { ExitChordNotice } from '../composer/ExitChordNotice.js'

const NOTICE_INDENT = 2

export function SurfaceExitChord({ onPendingChange }: { onPendingChange: (pending: boolean) => void }): null {
  const press = useDoublePress(
    onPendingChange,
    () => {
      void gracefulShutdown(0, 'quit')
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
  return (
    <Box
      position="absolute"
      top={Math.max(0, rows - 1)}
      left={0}
      width={columns}
      height={1}
      paddingLeft={NOTICE_INDENT}
      overflow="hidden"
      opaque={true}
    >
      <ExitChordNotice keyName="Ctrl-C" />
    </Box>
  )
}
