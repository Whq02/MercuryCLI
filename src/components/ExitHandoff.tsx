import React, { useEffect, useRef } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { HANDOFF_EXIT_NOTICE, leaveNoteBeforeExit, type ExitNoteOutcome } from '../mneme/exitHandoff.js'
import { FAINT } from './mercuryPalette.js'

export function ExitHandoff({ onSettled }: { onSettled: (outcome: ExitNoteOutcome) => void }): React.ReactNode {
  const controller = useRef(new AbortController())
  const settled = useRef(false)
  const settle = (outcome: ExitNoteOutcome): void => {
    if (settled.current) return
    settled.current = true
    onSettled(outcome)
  }
  useEffect(() => {
    leaveNoteBeforeExit({ signal: controller.current.signal }).then(settle, () => settle('none'))
  }, [])
  useInput((input, key) => {
    if (key.ctrl && input === 'c') controller.current.abort(new Error('the handoff was skipped by ctrl-c'))
  })
  return (
    <Box>
      <Text color={FAINT}>{HANDOFF_EXIT_NOTICE}</Text>
    </Box>
  )
}

export default ExitHandoff
