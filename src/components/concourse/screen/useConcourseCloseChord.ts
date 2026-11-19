import { useEffect, useRef } from 'react'
import { boardSelectionClassOf, closeChordReceiptOf, closeChordRungOf } from '../controlManifest.js'
import { claimConcourseCloseChord } from '../../../services/concourse/closeChordSlot.js'
import { createCloseChordStage, type CloseChordStage } from '../../../services/concourse/closeChordStage.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../../services/concourse/concourseSnapshot.js'
import { keyHintLabel } from '../../mercury-ui/keyHintLabel.js'
import type { Draft, Filter, ScreenDoors, ScreenProps, Selection } from './state.js'

export function useConcourseCloseChord({ callbacks, boardSelRef, closeChordBlocked, sessionRows, setNote }: Pick<ScreenProps, 'callbacks'> & Pick<Selection, 'boardSelRef'> & Pick<ScreenDoors, 'closeChordBlocked'> & Pick<Filter, 'sessionRows'> & Pick<Draft, 'setNote'>) {
  const closeChordStageRef = useRef<CloseChordStage | null>(null)
  if (closeChordStageRef.current === null) closeChordStageRef.current = createCloseChordStage()
  const closeChordStage = closeChordStageRef.current
  useEffect(() => () => closeChordStage.dispose(), [closeChordStage])
  const closeChordGesture = (): void => {
    if (closeChordBlocked()) return
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    if (!sel) return
    if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      setNote({ tone: 'muted', text: 'the older chats stay — ↵ opens them; clear one at a time from there', row: sel.sessionId })
      return
    }
    if (sel.door !== undefined) {
      setNote({
        tone: 'muted',
        text:
          sel.door.kind === 'switch-project'
            ? `a door — ↵ switches the board to ${sel.projectLabel}; nothing to close here`
            : 'a door — ↵ opens the repo picker; nothing to close here',
        row: sel.sessionId,
      })
      return
    }
    const rung = closeChordRungOf(boardSelectionClassOf(sel), closeChordStage.standsFor(sel.sessionId))
    const receipt = closeChordReceiptOf(rung)
    switch (rung) {
      case 'none':
        return
      case 'withdraw':
        callbacks.removeSession?.(sel.sessionId)
        return
      case 'stop':
        closeChordStage.arm(sel.sessionId)
        callbacks.stopSession?.(sel.sessionId)
        return
      case 'resend-stop':
        if (receipt !== null) setNote({ tone: 'muted', text: keyHintLabel(receipt), row: sel.sessionId })
        callbacks.stopSession?.(sel.sessionId)
        return
      case 'archive':
        closeChordStage.arm(sel.sessionId)
        callbacks.archiveSession?.(sel.sessionId)
        return
      case 'arm-delete':
        closeChordStage.arm(sel.sessionId)
        if (receipt !== null) setNote({ tone: 'muted', text: keyHintLabel(receipt), row: sel.sessionId })
        return
      case 'delete':
        closeChordStage.clear()
        setNote(prev => (prev?.row === sel.sessionId ? null : prev))
        callbacks.removeSession?.(sel.sessionId)
        return
    }
  }
  const closeChordRoutineRef = useRef(closeChordGesture)
  closeChordRoutineRef.current = closeChordGesture
  useEffect(() => claimConcourseCloseChord(() => closeChordRoutineRef.current()), [])
  return { closeChordStage }
}
