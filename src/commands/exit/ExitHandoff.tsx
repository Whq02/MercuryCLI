import React, { useRef } from 'react'
import { useLoad } from '../../screen/effects/effects.js'
import { Box, Text, useInput } from '../../screen/themedRenderer.js'
import { exitNoteCharsKept, exitNoteDue, HANDOFF_EXIT_NOTICE, leaveNoteBeforeExit, type ExitNoteOutcome } from '../../sessions/mneme/exitHandoff.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import { FAINT } from '../../screen/theme/mercuryPalette.js'
import { startTimeout } from '../../platform/async/timers.js'

export const HANDOFF_SKIP_GRACE_MS = 1_500

export function noteAskedAtExit(): boolean {
  return hasFocusedSession() || exitNoteDue()
}

export type ExitNoteReceipt = { note: ExitNoteOutcome; noteChars?: number; detail?: string }

export async function leaveNoteAtExit(signal: AbortSignal): Promise<ExitNoteReceipt> {
  if (!hasFocusedSession()) {
    const note = await leaveNoteBeforeExit({ signal })
    const kept = note === 'stored' ? exitNoteCharsKept() : null
    return { note, ...(kept === null ? {} : { noteChars: kept }) }
  }
  const receipt = await getFocusedSessionConnector().leave({ signal })
  return {
    note: receipt.note,
    ...(receipt.noteChars === undefined ? {} : { noteChars: receipt.noteChars }),
    ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
  }
}

export function ExitHandoff({ onSettled }: { onSettled: (receipt: ExitNoteReceipt) => void }): React.ReactNode {
  const controller = useRef(new AbortController())
  const settled = useRef(false)
  const settle = (receipt: ExitNoteReceipt): void => {
    if (settled.current) return
    settled.current = true
    onSettled(receipt)
  }
  useLoad(() => {
    leaveNoteAtExit(controller.current.signal).then(settle, () => settle({ note: 'none' }))
  }, [])
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.current.abort(new Error('the handoff was skipped by ctrl-c'))
      startTimeout(() => settle({ note: 'none' }), HANDOFF_SKIP_GRACE_MS)
    }
  })
  return (
    <Box>
      <Text color={FAINT}>{HANDOFF_EXIT_NOTICE}</Text>
    </Box>
  )
}

export default ExitHandoff
