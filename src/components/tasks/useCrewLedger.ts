import { useEffect, useMemo } from 'react'
import { useAppStateMaybeOutsideOfProvider, useSetAppStateMaybe, type AppState } from '../../state/AppState.js'
import { foldCrewLedger, seenCrewOf, sessionCrewRows, type CrewLedger, type CrewLedgerRow } from '../../state/crewLedger.js'
import { focusedSessionIdOrNull, useFocusedWorkRoster } from './useFocusedWork.js'

const EMPTY_LEDGER: CrewLedger = {}

export function useSessionCrew(): CrewLedgerRow[] {
  const tasks = useAppStateMaybeOutsideOfProvider((s: AppState) => s.tasks)
  const ledger = useAppStateMaybeOutsideOfProvider((s: AppState) => s.crewLedger) ?? EMPTY_LEDGER
  const setAppState = useSetAppStateMaybe()
  const roster = useFocusedWorkRoster()
  const sessionId = focusedSessionIdOrNull()
  const reported = roster.reported !== false
  const seen = useMemo(() => seenCrewOf(tasks, roster, sessionId), [tasks, roster, sessionId])
  useEffect(() => {
    if (setAppState === null) return
    setAppState(prev => {
      const next = foldCrewLedger(prev.crewLedger, seen, sessionId, reported, Date.now())
      return next === prev.crewLedger ? prev : { ...prev, crewLedger: next }
    })
  }, [setAppState, seen, sessionId, reported])
  return useMemo(() => sessionCrewRows(ledger, seen, sessionId, reported, Date.now()), [ledger, seen, sessionId, reported])
}

export function useCrewLedgerRow(taskId: string | undefined): CrewLedgerRow | null {
  const rows = useSessionCrew()
  return useMemo(() => (taskId === undefined ? null : rows.find(row => row.facts.id === taskId) ?? null), [rows, taskId])
}
