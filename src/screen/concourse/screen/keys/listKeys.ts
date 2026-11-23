import { OLDER_CHATS_ROW_PREFIX } from '../../../concourse-model/concourseSnapshot.js'
import { NEW_SESSION_ROW_ID } from '../../ConcourseLayout.js'
import { nudgeSplitRatio, toggleSplitView } from '../../splitView.js'
import type { InputEvent, Key } from '../../../themedRenderer.js'
import type { KeysArgs } from '../state.js'

export function listKeys(input: string, key: Key, event: InputEvent, { snapshot, callbacks, reducedStage, boardArmedRef, boardSelRef, compact, compactSteerOrEnter, enterSession, filterRef, geo, liveDraftRef, moveBoardSelection, newSessionLineNow, olderListRef, pastGate, region, rowArchive, rowControlRefused, rowControlSel, rowPauseToggle, rowStop, sendLive, sessionRows, setBoardScroll, setComposeContext, setFilter, setFiltering, setModelDefaultOpen, setNote, setOlderList, setRegion, setRowPeekOpen, setRowPick, splitActive, termCols, termRows, toggleMark, unfoldOlderList }: KeysArgs, olderNavConsumed: (key: { upArrow: boolean; downArrow: boolean }, event: { stopImmediatePropagation: () => void }) => boolean): boolean {
  if (region === 'list') {
    if (input === '/' && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      setFiltering(true)
      setFilter(f => ({ ...f, caret: f.text.length }))
      return true
    }
    if (key.upArrow || key.downArrow) {
      if (olderNavConsumed(key, event)) return true
      event.stopImmediatePropagation()
      moveBoardSelection(key.downArrow ? 1 : -1)
      return true
    }
    if (key.return && pastGate()) {
      event.stopImmediatePropagation()
      if (!reducedStage && liveDraftRef.current.text.trim().length > 0) {
        sendLive()
        return true
      }
      if (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow()) {
        callbacks.newSession?.()
        return true
      }
      if (sessionRows.length === 0) return true
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel) compactSteerOrEnter(sel)
      return true
    }
    if (key.rightArrow && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      if (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow()) return true
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel !== undefined && sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
        if (olderListRef.current !== null) setOlderList(null)
        else unfoldOlderList(sel)
        return true
      }
      if (sel !== undefined && (compact || boardArmedRef.current === sel.sessionId)) {
        enterSession(sel.sessionId)
        return true
      }
      setRowPeekOpen(v => !v)
      return true
    }
    if (input === 'x' && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      rowStop()
      return true
    }
    if (input === 'a' && !key.ctrl && !key.meta && !compact && pastGate()) {
      event.stopImmediatePropagation()
      rowArchive()
      return true
    }
    if ((key.pageUp || key.pageDown) && !key.ctrl && !key.meta && !compact) {
      event.stopImmediatePropagation()
      if (sessionRows.length === 0) return true
      const page = Math.max(1, geo.listContentRows - 1)
      setBoardScroll(v => {
        const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
        return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + (key.pageDown ? page : -page)))
      })
      return true
    }
    if (input === 'm' && !key.ctrl && !key.meta && !compact && !reducedStage && callbacks.newSession !== undefined && (sessionRows.length === 0 || (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow())) && filterRef.current.text.trim().length === 0 && snapshot.newSession.door !== undefined && pastGate()) {
      event.stopImmediatePropagation()
      setModelDefaultOpen(true)
      return true
    }
    if (input === 'm' && !key.ctrl && !key.meta && pastGate()) {
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel?.sessionId.startsWith('dispatch:') === true) {
        event.stopImmediatePropagation()
        callbacks.openQueuedRoom?.(sel.sessionId)
        return true
      }
      if (callbacks.setSessionModel !== undefined) {
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row === undefined) {
          rowControlRefused(target.reason ?? 'no session to switch')
          return true
        }
        if ((snapshot.newSession.modelOptions ?? []).length === 0) {
          rowControlRefused('no dispatchable models — /logins connects a family')
          return true
        }
        setRowPick({ kind: 'model', sessionId: target.row.sessionId, title: target.row.title })
        return true
      }
    }
    if (input === 'e' && !key.ctrl && !key.meta && callbacks.setSessionEffort !== undefined && pastGate()) {
      event.stopImmediatePropagation()
      const target = rowControlSel()
      if (target.row !== undefined) setRowPick({ kind: 'effort', sessionId: target.row.sessionId, title: target.row.title })
      else rowControlRefused(target.reason ?? 'no session to set')
      return true
    }
    if (input === 'i' && !key.ctrl && !key.meta && callbacks.interruptSession !== undefined && pastGate()) {
      event.stopImmediatePropagation()
      const target = rowControlSel()
      if (target.row !== undefined) callbacks.interruptSession(target.row.sessionId)
      else rowControlRefused(target.reason ?? 'nothing to interrupt')
      return true
    }
    if (input === 'p' && !key.ctrl && !key.meta && pastGate()) {
      event.stopImmediatePropagation()
      rowPauseToggle()
      return true
    }
    if (input === 'r' && !key.ctrl && !key.meta && !reducedStage && callbacks.renameSession !== undefined && pastGate()) {
      event.stopImmediatePropagation()
      const sel = sessionRows.find(row => row.sessionId === boardSelRef.current)
      if (!sel || sel.sessionId.startsWith('dispatch:') || sel.door !== undefined || sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) return true
      setComposeContext({ kind: 'rename', sessionId: sel.sessionId, title: sel.title })
      setRegion('live')
      return true
    }
    if (input === 'n' && !key.ctrl && !key.meta && !reducedStage && callbacks.newSession !== undefined && pastGate()) {
      event.stopImmediatePropagation()
      callbacks.newSession?.()
      return true
    }
    if (input === 's' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
      event.stopImmediatePropagation()
      if (compact) return true
      const out = toggleSplitView(termCols, termRows)
      if (!out.ok) setNote({ tone: 'muted', text: out.reason })
      else setNote(null)
      return true
    }
    if ((input === '[' || input === ']') && !key.ctrl && !key.meta && splitActive && pastGate()) {
      event.stopImmediatePropagation()
      nudgeSplitRatio(input === '[' ? -1 : 1)
      return true
    }
    if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
      event.stopImmediatePropagation()
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel !== undefined) toggleMark(sel.sessionId)
      return true
    }
  }
  return false
}
