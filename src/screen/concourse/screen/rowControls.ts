import { boardSelectionClassOf } from '../controlManifest.js'
import type { ConcourseRowV1 } from '../contracts.js'
import { keyHintLabel } from '../../widgets/keyHintLabel.js'
import type { Filter, ScreenProps, Selection } from './state.js'

export function concourseRowControls({ callbacks, boardSelRef, sessionRows }: Pick<ScreenProps, 'callbacks'> & Pick<Selection, 'boardSelRef'> & Pick<Filter, 'sessionRows'>) {
  const rowControlSel = (): { row?: ConcourseRowV1; reason?: string } => {
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    switch (boardSelectionClassOf(sel)) {
      case 'live':
      case 'paused':
        return { row: sel as ConcourseRowV1 }
      case 'parked':
        return { reason: 'parked · ↵ brings it back' }
      case 'queued':
        return { reason: `queued — not running yet · m queues a message · ${keyHintLabel('⌃x ⌃x')} withdraws` }
      case 'attached':
        return { reason: 'with you — its own chat carries the controls' }
      case 'stopped':
        return { reason: `stopped — ${keyHintLabel('⌃x ⌃x')} archives it` }
      case 'door':
        return { reason: 'a door — ↵ is its move' }
      case 'none':
        return { reason: 'no session selected' }
    }
  }
  const rowControlRefused = (reason: string): void => {
    callbacks.noteControl?.(`board:row-control:${boardSelRef.current ?? 'none'}`, { state: 'refused', reason })
  }
  const rowPauseToggle = (): void => {
    const target = rowControlSel()
    if (target.row !== undefined) {
      if (target.row.state === 'paused') callbacks.resumeSession(target.row.sessionId)
      else callbacks.pauseAfterTurn(target.row.sessionId)
    } else rowControlRefused(target.reason ?? 'nothing to pause')
  }
  const rowStop = (): void => {
    const target = rowControlSel()
    if (target.row === undefined) {
      rowControlRefused(target.reason ?? 'nothing to stop')
      return
    }
    callbacks.stopSession?.(target.row.sessionId)
  }
  const rowArchive = (): void => {
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    const selection = boardSelectionClassOf(sel)
    if (sel !== undefined && (selection === 'live' || selection === 'paused' || selection === 'stopped')) {
      callbacks.archiveSession?.(sel.sessionId)
      return
    }
    rowControlRefused(rowControlSel().reason ?? 'nothing to archive')
  }
  const selectedIsDoor = (): boolean => sessionRows.find(r => r.sessionId === boardSelRef.current)?.door !== undefined
  return { rowControlSel, rowControlRefused, rowPauseToggle, rowStop, rowArchive, selectedIsDoor }
}
