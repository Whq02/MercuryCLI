import { useInput } from '../../../ink.js'
import { helpKeyFiresFor } from '../controlManifest.js'
import { boardModalOwner } from '../boardModalOwner.js'
import { backspaceAt, caretVerticalOp, deleteAt, editorMotionOp, editorText, insertAt, recordDraftEdit, singleLine, undoDraft } from '../lineDraft.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../../services/concourse/concourseSnapshot.js'
import { NEW_SESSION_ROW_ID } from '../ConcourseLayout.js'
import { nudgeSplitRatio, toggleSplitView } from '../splitView.js'
import { hasFocusedSession, landingInFlight } from '../../../services/engine-connector/focusedConnector.js'
import { NL } from './useConcourseDraft.js'
import { broadcastFaceOf } from './composerGate.js'
import type { Asks, Draft, Filter, Frame, Geometry, Marks, Panes, Rail, Regions, RowControls, RowLine, ScreenDoors, ScreenProps, Selection } from './state.js'

export function useConcourseKeys({ snapshot, callbacks, degraded, reducedStage, answerCapacityAsk, answerTrustAsk, armContractAsk, beginAnswer, boardArmedRef, boardSelRef, broadcastArmedRef, capacityAskRef, clearDoorNote, compact, compactGeo, compactSteerOrEnter, composeContextRef, contractAskRef, doorNoteRef, editFilter, editLiveDraft, enterSession, filterRef, filtering, geo, gitOfferRef, groundPickerOpenRef, helpOpenRef, liveComposerGate, liveDraftRef, liveUndoRef, markedIdsRef, markedRowsOf, modelDefaultOpenRef, moveBoardSelection, newSessionLineNow, olderListRef, openObligationOrDoor, pastGate, railSelRef, region, regionsInOrder, rowArchive, rowControlRefused, rowControlSel, rowPauseToggle, rowPeekOpenRef, rowPickRef, rowStop, selectedIsDoor, sendLive, sessionRows, setBoardArmed, setBoardScroll, setBroadcastArmed, setComposeContext, setFilter, setFiltering, setGroundPickerOpen, setHelpOpen, setLiveDraft, setLiveNote, setMarkedIds, setModelDefaultOpen, setNote, setOlderList, setRailSel, setRegion, setRowPeekOpen, setRowPick, showDoorNote, splitActive, termCols, termRows, toggleMark, trustAskRef, unfoldOlderList }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'degraded' | 'reducedStage'> & Pick<Asks, 'answerCapacityAsk' | 'answerTrustAsk' | 'armContractAsk' | 'capacityAskRef' | 'contractAskRef' | 'trustAskRef'> & Pick<ScreenDoors, 'beginAnswer' | 'compactSteerOrEnter' | 'enterSession' | 'gitOfferRef' | 'moveBoardSelection' | 'openObligationOrDoor' | 'unfoldOlderList'> & Pick<Marks, 'boardArmedRef' | 'clearDoorNote' | 'doorNoteRef' | 'markedIdsRef' | 'markedRowsOf' | 'modelDefaultOpenRef' | 'rowPickRef' | 'setBoardArmed' | 'setMarkedIds' | 'setModelDefaultOpen' | 'setRowPick' | 'showDoorNote' | 'toggleMark'> & Pick<Selection, 'boardSelRef' | 'olderListRef' | 'rowPeekOpenRef' | 'setBoardScroll' | 'setOlderList' | 'setRowPeekOpen'> & Pick<Draft, 'broadcastArmedRef' | 'composeContextRef' | 'editLiveDraft' | 'liveComposerGate' | 'liveDraftRef' | 'liveUndoRef' | 'sendLive' | 'setBroadcastArmed' | 'setComposeContext' | 'setLiveDraft' | 'setLiveNote' | 'setNote'> & Pick<Frame, 'compact' | 'splitActive' | 'termCols' | 'termRows'> & Pick<Geometry, 'compactGeo' | 'geo'> & Pick<Filter, 'editFilter' | 'filterRef' | 'filtering' | 'newSessionLineNow' | 'sessionRows' | 'setFilter' | 'setFiltering'> & Pick<Panes, 'groundPickerOpenRef' | 'helpOpenRef' | 'region' | 'setGroundPickerOpen' | 'setHelpOpen' | 'setRegion'> & Pick<RowLine, 'pastGate'> & Pick<Rail, 'railSelRef' | 'setRailSel'> & Pick<Regions, 'regionsInOrder'> & Pick<RowControls, 'rowArchive' | 'rowControlRefused' | 'rowControlSel' | 'rowPauseToggle' | 'rowStop' | 'selectedIsDoor'>) {
  const olderNavConsumed = (
    key: { upArrow: boolean; downArrow: boolean },
    event: { stopImmediatePropagation: () => void },
  ): boolean => {
    const open = olderListRef.current
    if (open === null || !(key.upArrow || key.downArrow)) return false
    event.stopImmediatePropagation()
    const at = Math.min(open.entries.length - 1, Math.max(0, open.at + (key.downArrow ? 1 : -1)))
    if (at !== open.at) setOlderList({ ...open, at })
    return true
  }

  useInput((input, key, event) => {
    if (doorNoteRef.current) clearDoorNote()
    const modalOwner = boardModalOwner({
      capacityAsk: capacityAskRef.current,
      trustAsk: trustAskRef.current !== null,
      groundPickerOpen: groundPickerOpenRef.current,
      rowPick: rowPickRef.current !== null,
      modelDefault: modelDefaultOpenRef.current,
      gitOffer: gitOfferRef.current !== undefined,
      contractAsk: contractAskRef.current,
      helpOpen: helpOpenRef.current,
    })
    const plainConsent = !key.ctrl && !key.meta && !key.super
    if (modalOwner === null && callbacks.daemonOfferArmed?.() === true && callbacks.answerDaemonOffer !== undefined) {
      if (plainConsent && (input === 'y' || input === 'Y')) {
        event.stopImmediatePropagation()
        callbacks.answerDaemonOffer(true)
        return
      }
      if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) {
        event.stopImmediatePropagation()
        callbacks.answerDaemonOffer(false)
        return
      }
    }
    if (modalOwner === 'help') {
      event.stopImmediatePropagation()
      if (key.escape || input === '?' || key.return) {
        helpOpenRef.current = false
        setHelpOpen(false)
      }
      return
    }
    if (modalOwner === 'capacity-ask') {
      event.stopImmediatePropagation()
      if (plainConsent && (input === 'y' || input === 'Y')) answerCapacityAsk(true)
      else if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) answerCapacityAsk(false)
      return
    }
    if (modalOwner === 'trust-ask') {
      event.stopImmediatePropagation()
      if (plainConsent && (input === 'y' || input === 'Y')) answerTrustAsk(true)
      else if (key.escape || (plainConsent && (input === 'n' || input === 'N'))) answerTrustAsk(false)
      return
    }
    if (modalOwner !== null) return
    const ctx = composeContextRef.current
    if (key.tab && !filtering) {
      event.stopImmediatePropagation()
      const dir = key.shift ? -1 : 1
      setRegion(prev => {
        const at = regionsInOrder.indexOf(prev)
        return regionsInOrder[(at + dir + regionsInOrder.length) % regionsInOrder.length]!
      })
      return
    }
    if (filtering) {
      if (key.escape) {
        event.stopImmediatePropagation()
        setFiltering(false)
        setFilter({ text: '', caret: 0 })
        return
      }
      if (key.return || key.tab) {
        event.stopImmediatePropagation()
        setFiltering(false)
        return
      }
      if (key.backspace) {
        event.stopImmediatePropagation()
        editFilter(backspaceAt)
        return
      }
      if (key.delete) {
        event.stopImmediatePropagation()
        editFilter(deleteAt)
        return
      }
      const filterMotion = editorMotionOp(key)
      if (filterMotion !== null) {
        event.stopImmediatePropagation()
        editFilter(filterMotion)
        return
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        editFilter(d => insertAt(d, singleLine(input)))
        return
      }
      return
    }
    if (key.wheelUp || key.wheelDown) {
      const kp = event.keypress as { x?: number; y?: number }
      const compactListPainted = compactGeo?.profile === 'split' || (compactGeo?.profile === 'single' && region === 'list' && !contractAskRef.current)
      const overList =
        kp.x !== undefined && kp.y !== undefined
          ? compactGeo !== null
            ? compactListPainted &&
              kp.x >= compactGeo.list.x0 + 1 &&
              kp.x <= compactGeo.list.x1 + 1 &&
              kp.y >= compactGeo.list.y0 + 2 &&
              kp.y <= compactGeo.list.y1
            : kp.y >= geo.listBand[0] &&
              kp.y <= geo.listBand[1] &&
              kp.x >= (geo.profile === 'wide' ? geo.rightCols[0] : 3) &&
              kp.x <= (geo.profile === 'wide' ? geo.rightCols[1] : 2 + geo.interior)
          : region === 'list'
      if (!overList) return
      event.stopImmediatePropagation()
      if (sessionRows.length === 0) return
      const dir = key.wheelDown ? 1 : -1
      setBoardScroll(v => {
        const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
        return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + dir * (event.wheelStep ? 1 : 3)))
      })
      return
    }
    if (key.ctrl && input === 'g') {
      event.stopImmediatePropagation()
      setGroundPickerOpen(v => !v)
      return
    }
    if (key.escape) {
      event.stopImmediatePropagation()
      if (ctx.kind !== 'chat') {
        setComposeContext({ kind: 'chat' })
        return
      }
      if (olderListRef.current !== null) {
        setOlderList(null)
        return
      }
      if (broadcastArmedRef.current) {
        broadcastArmedRef.current = false
        setBroadcastArmed(false)
        return
      }
      if (compact && region === 'live') {
        boardArmedRef.current = null
        setBoardArmed(null)
        setRegion('list')
        return
      }
      if (boardArmedRef.current !== null) {
        boardArmedRef.current = null
        setBoardArmed(null)
        if (!compact) return
      }
      if (rowPeekOpenRef.current) {
        setRowPeekOpen(false)
        return
      }
      if (filterRef.current.text !== '') {
        filterRef.current = { text: '', caret: 0 }
        setFilter(filterRef.current)
        return
      }
      if (markedIdsRef.current.size > 0) {
        setMarkedIds(new Set())
        return
      }
      callbacks.exitToChat()
      return
    }
    if (degraded && key.ctrl && input === 'r') {
      event.stopImmediatePropagation()
      callbacks.retrySnapshot?.()
      return
    }
    if (region === 'rail') {
      const liveRailIdx = (): number =>
        Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSelRef.current))
      if (key.upArrow || key.downArrow) {
        event.stopImmediatePropagation()
        const n = snapshot.needsYou.length
        if (n > 0) {
          const next = Math.min(n - 1, Math.max(0, liveRailIdx() + (key.downArrow ? 1 : -1)))
          railSelRef.current = snapshot.needsYou[next]?.obligationId ?? null
          setRailSel(railSelRef.current)
        }
        return
      }
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) beginAnswer(o.obligationId)
        return
      }
      if (input === 'o' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) openObligationOrDoor(o.obligationId)
        return
      }
      if (input === 'w' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) callbacks.withdrawObligation(o.obligationId)
        return
      }
    }
    if (region === 'list') {
      if (input === '/' && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        setFiltering(true)
        setFilter(f => ({ ...f, caret: f.text.length }))
        return
      }
      if (key.upArrow || key.downArrow) {
        if (olderNavConsumed(key, event)) return
        event.stopImmediatePropagation()
        moveBoardSelection(key.downArrow ? 1 : -1)
        return
      }
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        if (!reducedStage && liveDraftRef.current.text.trim().length > 0) {
          sendLive()
          return
        }
        if (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow()) {
          armContractAsk()
          return
        }
        if (sessionRows.length === 0) return
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel) compactSteerOrEnter(sel)
        return
      }
      if (key.rightArrow && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        if (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow()) return
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
      if (input === 'x' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        rowStop()
        return
      }
      if (input === 'a' && !key.ctrl && !key.meta && !compact && pastGate()) {
        event.stopImmediatePropagation()
        rowArchive()
        return
      }
      if ((key.pageUp || key.pageDown) && !key.ctrl && !key.meta && !compact) {
        event.stopImmediatePropagation()
        if (sessionRows.length === 0) return
        const page = Math.max(1, geo.listContentRows - 1)
        setBoardScroll(v => {
          const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
          return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + (key.pageDown ? page : -page)))
        })
        return
      }
      if (input === 'm' && !key.ctrl && !key.meta && !compact && !reducedStage && callbacks.newSession !== undefined && (sessionRows.length === 0 || (boardSelRef.current === NEW_SESSION_ROW_ID && newSessionLineNow())) && filterRef.current.text.trim().length === 0 && snapshot.newSession.door !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        setModelDefaultOpen(true)
        return
      }
      if (input === 'm' && !key.ctrl && !key.meta && pastGate()) {
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel?.sessionId.startsWith('dispatch:') === true) {
          event.stopImmediatePropagation()
          callbacks.openQueuedRoom?.(sel.sessionId)
          return
        }
        if (callbacks.setSessionModel !== undefined) {
          event.stopImmediatePropagation()
          const target = rowControlSel()
          if (target.row === undefined) {
            rowControlRefused(target.reason ?? 'no session to switch')
            return
          }
          if ((snapshot.newSession.modelOptions ?? []).length === 0) {
            rowControlRefused('no dispatchable models — /logins connects a family')
            return
          }
          setRowPick({ kind: 'model', sessionId: target.row.sessionId, title: target.row.title })
          return
        }
      }
      if (input === 'e' && !key.ctrl && !key.meta && callbacks.setSessionEffort !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) setRowPick({ kind: 'effort', sessionId: target.row.sessionId, title: target.row.title })
        else rowControlRefused(target.reason ?? 'no session to set')
        return
      }
      if (input === 'i' && !key.ctrl && !key.meta && callbacks.interruptSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) callbacks.interruptSession(target.row.sessionId)
        else rowControlRefused(target.reason ?? 'nothing to interrupt')
        return
      }
      if (input === 'p' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        rowPauseToggle()
        return
      }
      if (input === 'r' && !key.ctrl && !key.meta && !reducedStage && callbacks.renameSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        const sel = sessionRows.find(row => row.sessionId === boardSelRef.current)
        if (!sel || sel.sessionId.startsWith('dispatch:') || sel.door !== undefined || sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) return
        setComposeContext({ kind: 'rename', sessionId: sel.sessionId, title: sel.title })
        setRegion('live')
        return
      }
      if (input === 'n' && !key.ctrl && !key.meta && !reducedStage && callbacks.newSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        event.stopImmediatePropagation()
        if (compact) return
        const out = toggleSplitView(termCols, termRows)
        if (!out.ok) setNote({ tone: 'muted', text: out.reason })
        else setNote(null)
        return
      }
      if ((input === '[' || input === ']') && !key.ctrl && !key.meta && splitActive && pastGate()) {
        event.stopImmediatePropagation()
        nudgeSplitRatio(input === '[' ? -1 : 1)
        return
      }
      if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        event.stopImmediatePropagation()
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel !== undefined) toggleMark(sel.sessionId)
        return
      }
    }
    if (region === 'chat') {
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        if (hasFocusedSession()) callbacks.exitToChat()
        else if (!landingInFlight()) armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        toggleSplitView(termCols, termRows)
        return
      }
      if ((input === '[' || input === ']') && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        nudgeSplitRatio(input === '[' ? -1 : 1)
        return
      }
    }
    if (
      (region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL)) ||
      (region === 'chat' && (key.upArrow || key.downArrow))
    ) {
      if (olderNavConsumed(key, event)) return
      event.stopImmediatePropagation()
      moveBoardSelection(key.downArrow ? 1 : -1)
      return
    }
    if (
      input === '?' &&
      !key.ctrl &&
      !key.meta &&
      helpKeyFiresFor(region, liveDraftRef.current.text.length === 0)
    ) {
      event.stopImmediatePropagation()
      helpOpenRef.current = true
      setHelpOpen(true)
      return
    }
    if (compact && region === 'live' && !key.ctrl && !key.meta && (input === 'x' || input === 'p') && liveDraftRef.current.text.length === 0 && pastGate()) {
      event.stopImmediatePropagation()
      if (input === 'x') rowStop()
      else rowPauseToggle()
      return
    }
    if (key.return && !key.shift) {
      if (region !== 'live') return
      event.stopImmediatePropagation()
      if (!pastGate()) return
      if (compact && selectedIsDoor()) {
        showDoorNote()
        return
      }
      if (liveDraftRef.current.text.trim().length === 0) {
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel) enterSession(sel.sessionId)
        return
      }
      sendLive()
      return
    }
    if (reducedStage) {
      return
    }
    if (region === 'chat') {
      return
    }
    if (region !== 'live') {
      return
    }
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
  })
}
