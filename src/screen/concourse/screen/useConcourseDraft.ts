import { useMemo, useRef, useState } from 'react'
import type { ConcourseRowV1 } from '../contracts.js'
import { newDraftUndo, type LineDraft } from '../lineDraft.js'
import type { ConcourseRegion } from '../ConcourseLayout.js'
import { credentialWallLineForModel } from '../../../models/roads/credentialWall.js'
import { liveComposerGateOf, broadcastSummaryOf } from './composerGate.js'
import type { Filter, Marks, ScreenProps, Selection } from './state.js'

type ComposeContext =
  | { kind: 'chat' }
  | { kind: 'answer'; obligationId: string; title: string }
  | { kind: 'rename'; sessionId: string; title: string }

export const NL = String.fromCharCode(10)

export function useConcourseDraft({ snapshot, callbacks, reducedStage, boardSel, boardSelRef, markedIds, markedRowsOf, sessionRows }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'reducedStage'> & Pick<Selection, 'boardSel' | 'boardSelRef'> & Pick<Marks, 'markedIds' | 'markedRowsOf'> & Pick<Filter, 'sessionRows'>) {
  const [liveDraft, setLiveDraft] = useState<LineDraft>({ text: '', caret: 0 })
  const liveDraftRef = useRef<LineDraft>(liveDraft)
  liveDraftRef.current = liveDraft
  const liveUndoRef = useRef(newDraftUndo())
  const editLiveDraft = (op: (d: LineDraft) => LineDraft): void => {
    liveDraftRef.current = op(liveDraftRef.current)
    setLiveDraft(liveDraftRef.current)
  }
  const clearLiveDraft = (): void => {
    liveDraftRef.current = { text: '', caret: 0 }
    setLiveDraft(liveDraftRef.current)
    liveUndoRef.current = newDraftUndo()
  }
  const [rawBroadcastArmed, setBroadcastArmed] = useState(false)
  const [broadcastKey, setBroadcastKey] = useState({ text: liveDraft.text, markedIds })
  let broadcastArmed = rawBroadcastArmed
  if (broadcastKey.text !== liveDraft.text || broadcastKey.markedIds !== markedIds) {
    setBroadcastKey({ text: liveDraft.text, markedIds })
    if (rawBroadcastArmed) {
      setBroadcastArmed(false)
      broadcastArmed = false
    }
  }
  const broadcastArmedRef = useRef(false)
  broadcastArmedRef.current = broadcastArmed

  const [rawNote, setNote] = useState<{ tone: 'muted' | 'warning'; text: string; row?: string } | null>(null)
  const staleRowNote =
    rawNote?.row !== undefined &&
    (boardSel !== rawNote.row || !sessionRows.some(r => r.sessionId === rawNote.row))
  const note = staleRowNote ? null : rawNote
  if (staleRowNote) setNote(null)
  const [liveNote, setLiveNote] = useState<{ tone: 'muted' | 'warning'; text: string } | null>(null)
  const [composeContext, setComposeContext] = useState<ComposeContext>({ kind: 'chat' })
  const composeContextRef = useRef<ComposeContext>(composeContext)
  composeContextRef.current = composeContext
  const wallLineBySession = useMemo(() => {
    const lines = new Map<string, string>()
    for (const row of sessionRows) {
      const line = credentialWallLineForModel(row.modelId)
      if (line !== undefined) lines.set(row.sessionId, line)
    }
    return lines
  }, [sessionRows])
  const liveComposerGate = (
    sel: ConcourseRowV1 | undefined,
    noteRegion?: ConcourseRegion,
  ): { ok: true; placeholder: string } | { ok: false; line: string } =>
    liveComposerGateOf(
      sel,
      sel !== undefined && snapshot.needsYou.some(o => o.sessionId === sel.sessionId),
      noteRegion,
      sel !== undefined ? wallLineBySession.get(sel.sessionId) : undefined,
    )

  const sendLive = (): void => {
    if (reducedStage) return
    const ctx = composeContextRef.current
    const text = liveDraftRef.current.text.trim()
    if (text.length === 0) return
    if (ctx.kind === 'answer') {
      callbacks.answerObligation(ctx.obligationId, text)
      clearLiveDraft()
      setComposeContext({ kind: 'chat' })
      return
    }
    if (ctx.kind === 'rename') {
      callbacks.renameSession?.(ctx.sessionId, text)
      clearLiveDraft()
      setComposeContext({ kind: 'chat' })
      return
    }
    const marked = markedRowsOf()
    if (marked.length >= 2) {
      if (!broadcastArmedRef.current) {
        broadcastArmedRef.current = true
        setBroadcastArmed(true)
        return
      }
      broadcastArmedRef.current = false
      setBroadcastArmed(false)
      let sent = 0
      for (const row of marked) {
        const rowGate = liveComposerGate(row)
        if (rowGate.ok) {
          callbacks.redirectSession(row.sessionId, text)
          callbacks.noteControl?.(`board:row-control:${row.sessionId}`, {
            state: 'applied',
            reason: 'broadcast sent — queued for its next turn',
          })
          sent += 1
        } else {
          callbacks.noteControl?.(`board:row-control:${row.sessionId}`, {
            state: 'refused',
            reason: `skipped — ${rowGate.line}`,
          })
        }
      }
      setLiveNote({ tone: sent > 0 ? 'muted' : 'warning', text: broadcastSummaryOf(sent, marked.length) })
      clearLiveDraft()
      return
    }
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    const gate = liveComposerGate(sel)
    if (!gate.ok) {
      setLiveNote({ tone: 'muted', text: gate.line })
      return
    }
    callbacks.redirectSession(sel!.sessionId, text)
    clearLiveDraft()
  }
  return { liveDraft, setLiveDraft, liveDraftRef, liveUndoRef, editLiveDraft, broadcastArmed, setBroadcastArmed, broadcastArmedRef, note, setNote, liveNote, setLiveNote, composeContext, setComposeContext, composeContextRef, liveComposerGate, sendLive }
}
