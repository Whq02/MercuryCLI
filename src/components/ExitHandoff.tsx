import React, { useEffect, useRef } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { exitNoteCharsKept, exitNoteDue, HANDOFF_EXIT_NOTICE, leaveNoteBeforeExit, type ExitNoteOutcome } from '../mneme/exitHandoff.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../services/engine-connector/focusedConnector.js'
import { FAINT } from './mercuryPalette.js'

export const HANDOFF_SKIP_GRACE_MS = 1_500

export function noteAskedAtExit(): boolean {
  return hasFocusedSession() || exitNoteDue()
}

export type ExitNoteReceipt = { note: ExitNoteOutcome; noteChars?: number }

export async function leaveNoteAtExit(signal: AbortSignal): Promise<ExitNoteReceipt> {
  if (!hasFocusedSession()) {
    const note = await leaveNoteBeforeExit({ signal })
    const kept = note === 'stored' ? exitNoteCharsKept() : null
    return { note, ...(kept === null ? {} : { noteChars: kept }) }
  }
  const receipt = await getFocusedSessionConnector().leave({ signal })
  return { note: receipt.note, ...(receipt.noteChars === undefined ? {} : { noteChars: receipt.noteChars }) }
}

export function ExitHandoff({ onSettled }: { onSettled: (receipt: ExitNoteReceipt) => void }): React.ReactNode {
  const controller = useRef(new AbortController())
  const settled = useRef(false)
  const settle = (receipt: ExitNoteReceipt): void => {
    if (settled.current) return
    settled.current = true
    onSettled(receipt)
  }
  useEffect(() => {
    leaveNoteAtExit(controller.current.signal).then(settle, () => settle({ note: 'none' }))
  }, [])
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.current.abort(new Error('the handoff was skipped by ctrl-c'))
      setTimeout(() => settle({ note: 'none' }), HANDOFF_SKIP_GRACE_MS)
    }
  })
  return (
    <Box>
      <Text color={FAINT}>{HANDOFF_EXIT_NOTICE}</Text>
    </Box>
  )
}

export default ExitHandoff
