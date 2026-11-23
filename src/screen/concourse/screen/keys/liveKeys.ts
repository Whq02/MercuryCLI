import { backspaceAt, caretVerticalOp, deleteAt, editorMotionOp, editorText, insertAt, recordDraftEdit, undoDraft } from '../../lineDraft.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../../concourse-model/concourseSnapshot.js'
import { NL } from '../useConcourseDraft.js'
import { broadcastFaceOf } from '../composerGate.js'
import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function liveComposerKeys(input: string, key: Key, event: InputEvent, { boardArmedRef, boardSelRef, compact, composeContextRef, editLiveDraft, enterSession, liveComposerGate, liveDraftRef, liveUndoRef, markedRowsOf, olderListRef, selectedIsDoor, sessionRows, setBoardArmed, setLiveDraft, setLiveNote, setOlderList, setRowPeekOpen, unfoldOlderList }: KeysArgs): void {
  const liveGateRefusal = (): string | null => {
    if (composeContextRef.current.kind !== 'chat') return null
    if (compact && selectedIsDoor()) return null
    if (broadcastFaceOf(markedRowsOf().length) !== null) return null
    const g = liveComposerGate(sessionRows.find(r => r.sessionId === boardSelRef.current))
    return g.ok ? null : g.line
  }
  const armSelectedForTyping = (): void => {
    if (boardArmedRef.current !== null) return
    if (broadcastFaceOf(markedRowsOf().length) !== null) return
    const selId = boardSelRef.current
    if (selId !== null) {
      boardArmedRef.current = selId
      setBoardArmed(selId)
    }
  }
  if ((key.return && key.shift) || (key.ctrl && input === 'j')) {
    event.stopImmediatePropagation()
    const refusal = liveGateRefusal()
    if (refusal !== null) {
      setLiveNote({ tone: 'muted', text: refusal })
      return
    }
    armSelectedForTyping()
    recordDraftEdit(liveUndoRef.current, liveDraftRef.current, 'type')
    editLiveDraft(d => insertAt(d, NL))
    return
  }
  if (key.ctrl && input === 'c' && liveDraftRef.current.text.length > 0) {
    event.stopImmediatePropagation()
    recordDraftEdit(liveUndoRef.current, liveDraftRef.current, 'clear')
    editLiveDraft(() => ({ text: '', caret: 0 }))
    return
  }
  if (key.ctrl && input === '_') {
    event.stopImmediatePropagation()
    const prev = undoDraft(liveUndoRef.current)
    if (prev !== null) {
      liveDraftRef.current = prev
      setLiveDraft(prev)
    }
    return
  }
  if (key.backspace || key.delete) {
    event.stopImmediatePropagation()
    recordDraftEdit(liveUndoRef.current, liveDraftRef.current, 'delete')
    editLiveDraft(key.backspace ? backspaceAt : deleteAt)
    return
  }
  if (key.rightArrow && !key.ctrl && !key.meta && liveDraftRef.current.text.length === 0) {
    event.stopImmediatePropagation()
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    if (sel !== undefined && sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      if (olderListRef.current !== null) setOlderList(null)
      else unfoldOlderList(sel)
      return
    }
    if (sel !== undefined && (compact || boardArmedRef.current === sel.sessionId)) {
      enterSession(sel.sessionId)
      return
    }
    setRowPeekOpen(v => !v)
    return
  }
  const motion = editorMotionOp(key)
  if (motion !== null) {
    event.stopImmediatePropagation()
    editLiveDraft(motion)
    return
  }
  const vertical = caretVerticalOp(key, liveDraftRef.current)
  if (vertical !== null) {
    event.stopImmediatePropagation()
    editLiveDraft(vertical)
    return
  }
  if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
    event.stopImmediatePropagation()
    const refusal = liveGateRefusal()
    if (refusal !== null) {
      setLiveNote({ tone: 'muted', text: refusal })
      return
    }
    armSelectedForTyping()
    const payload = editorText(input)
    recordDraftEdit(liveUndoRef.current, liveDraftRef.current, payload.length > 1 ? 'paste' : 'type')
    editLiveDraft(d => insertAt(d, payload))
    return
  }
}
