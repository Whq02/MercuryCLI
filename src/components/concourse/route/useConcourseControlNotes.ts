import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlNoteState } from '../contracts.js';
import { CONTROL_NOTE_REFUSED_MS, CONTROL_NOTE_SETTLED_MS, controlNoteOf } from '../contracts.js';

export function useConcourseControlNotes() {
  const [controlNotes, setControlNotes] = useState<Readonly<Record<string, ControlNoteState>>>({})
  const noteSeqRef = useRef(0)
  const noteIdentityRef = useRef<Record<string, number>>({})
  const noteTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(
    () => () => {
      for (const t of Object.values(noteTimersRef.current)) clearTimeout(t)
      noteTimersRef.current = {}
    },
    [],
  )
  const noteControl = useCallback((control: string, state: ControlNoteState): void => {
    setControlNotes(prev => ({ ...prev, [control]: state }))
    const mySeq = ++noteSeqRef.current
    noteIdentityRef.current[control] = mySeq
    const stale = noteTimersRef.current[control]
    if (stale !== undefined) {
      clearTimeout(stale)
      delete noteTimersRef.current[control]
    }
    const kind = controlNoteOf(state).state
    if (kind !== 'pending') {
      const timer = setTimeout(() => {
        if (noteIdentityRef.current[control] !== mySeq) return
        delete noteTimersRef.current[control]
        setControlNotes(prev => {
          const next = { ...prev }
          delete next[control]
          return next
        })
      }, kind === 'refused' || kind === 'failed' ? CONTROL_NOTE_REFUSED_MS : CONTROL_NOTE_SETTLED_MS)
      timer.unref?.()
      noteTimersRef.current[control] = timer
    }
  }, [])
  return { controlNotes, noteControl }
}
