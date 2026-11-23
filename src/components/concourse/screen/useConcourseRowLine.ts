import { useSyncExternalStore } from 'react'
import { stringWidth } from '../../../ink/stringWidth.js'
import { boardSelectionClassOf, closeChordHintOf, closeChordRungOf } from '../controlManifest.js'
import { useOpenEventGate } from '../../mercury-ui/useOpenEventGate.js'
import { boardModalOwner } from '../boardModalOwner.js'
import { getPendingChordMirror, subscribePendingChordMirror } from '../../../keybindings/pendingChordMirror.js'
import { controlNoteOf } from '../contracts.js'
import { PARK_REFUSED_NOW_LEAD } from '../../../services/concourse/concourseSnapshot.js'
import { useLiveTile, useWorkChip } from '../liveTiles.js'
import { GLYPH } from '../../../utils/glyphs.js'
import { keyHintLabel } from '../../mercury-ui/keyHintLabel.js'
import { broadcastFaceOf } from './composerGate.js'
import type { Asks, CloseChord, Draft, Filter, Marks, Panes, ScreenDoors, ScreenProps, Selection } from './state.js'

export function useConcourseRowLine({ callbacks, controlNotes, boardArmed, boardSel, capacityAsk, closeChordStage, filtering, gitOffer, groundPickerOpen, helpOpen, liveComposerGate, liveDraft, markedRows, modelDefaultOpen, rowPeekOpen, rowPick, sessionRows, trustAsk }: Pick<ScreenProps, 'callbacks' | 'controlNotes'> & Pick<Marks, 'boardArmed' | 'markedRows' | 'modelDefaultOpen' | 'rowPick'> & Pick<Selection, 'boardSel' | 'rowPeekOpen'> & Pick<Asks, 'capacityAsk' | 'trustAsk'> & Pick<CloseChord, 'closeChordStage'> & Pick<Filter, 'filtering' | 'sessionRows'> & Pick<ScreenDoors, 'gitOffer'> & Pick<Panes, 'groundPickerOpen' | 'helpOpen'> & Pick<Draft, 'liveComposerGate' | 'liveDraft'>) {
  const pastGate = useOpenEventGate()
  const peekSelRow = sessionRows.find(r => r.sessionId === boardSel)
  const peekRowLive =
    rowPeekOpen &&
    peekSelRow !== undefined &&
    (peekSelRow.state === 'working' || peekSelRow.state === 'needs-you' || peekSelRow.state === 'starting')
  const peekLive = useLiveTile(peekSelRow?.sessionId ?? '', peekSelRow?.workspaceDir, peekRowLive)
  const chipLine = useWorkChip(
    peekSelRow?.sessionId ?? '',
    peekSelRow !== undefined && peekSelRow.workspaceDir !== undefined && peekSelRow.state !== 'parked',
  )
  const rowControlNote = controlNotes?.[`board:row-control:${peekSelRow?.sessionId ?? 'none'}`]
  const pendingChordNow = useSyncExternalStore(subscribePendingChordMirror, getPendingChordMirror, getPendingChordMirror)
  const chordStageNow = useSyncExternalStore(closeChordStage.subscribe, closeChordStage.read, closeChordStage.read)
  const closeChordStaged = chordStageNow !== null && chordStageNow.sessionId === boardSel
  const closeChordHint = ((): string | null => {
    const stroke = pendingChordNow?.length === 1 ? pendingChordNow[0] : undefined
    const leaderPending =
      stroke !== undefined && stroke.key === 'x' && stroke.ctrl && !stroke.shift && !stroke.super && !(stroke.alt || stroke.meta)
    if (!leaderPending || peekSelRow === undefined) return null
    const boardOwned =
      callbacks.daemonOfferArmed?.() !== true &&
      !helpOpen &&
      !filtering &&
      boardModalOwner({
        capacityAsk,
        trustAsk: trustAsk !== null,
        groundPickerOpen,
        rowPick: rowPick !== null,
        modelDefault: modelDefaultOpen,
        gitOffer: gitOffer !== undefined,
      }) === null
    if (!boardOwned) return null
    const hint = closeChordHintOf(closeChordRungOf(boardSelectionClassOf(peekSelRow), closeChordStaged), peekSelRow?.newborn === true)
    return hint === null ? null : keyHintLabel(hint)
  })()
  const selectedRowLineOf = (nowCellWidth: number): { glyph: string; words: string; tone: 'info' | 'success' | 'instruction' | 'warning' | 'failure' } | null => {
    const sel = peekSelRow
    if (sel === undefined) return null
    if (closeChordHint !== null) return { glyph: GLYPH.handoff, words: closeChordHint, tone: 'info' }
    if (rowControlNote !== undefined) {
      const n = controlNoteOf(rowControlNote)
      return {
        glyph: n.state === 'applied' ? GLYPH.ok : n.state === 'pending' || n.state === 'held' ? GLYPH.pending : GLYPH.fail,
        words: `${n.reason ?? n.state}${n.next !== undefined ? ` · ${n.next}` : ''}`,
        tone: n.state === 'applied' ? 'success' : n.state === 'pending' ? 'instruction' : n.state === 'held' ? 'warning' : 'failure',
      }
    }
    if (boardArmed === sel.sessionId) {
      return {
        glyph: GLYPH.handoff,
        words: `${liveDraft.text.trim().length > 0 ? 'armed — ↵ sends the draft · → enters' : 'armed — ↵ again enters'}${liveDraft.text.trim().length === 0 && liveComposerGate(sel).ok && broadcastFaceOf(markedRows.length) === null ? ' · tab to message' : ''} · esc disarms`,
        tone: 'info',
      }
    }
    const refusal = sel.nowLabel ?? ''
    if (refusal.startsWith(PARK_REFUSED_NOW_LEAD) && stringWidth(refusal) > nowCellWidth) return { glyph: GLYPH.fail, words: refusal, tone: 'failure' }
    if (chipLine !== null) return { glyph: GLYPH.ok, words: chipLine, tone: 'warning' }
    return null
  }
  return { pastGate, peekSelRow, peekLive, rowControlNote, closeChordStaged, selectedRowLineOf }
}
