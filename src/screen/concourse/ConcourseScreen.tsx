import React, { useMemo, useRef } from 'react'
import { useClaim } from '../effects/effects.js'
import { boardModalOwner, type BoardModalFactsV1 } from './boardModalOwner.js'
import { type ConcourseCallbacks, type ConcourseRowV1, type ConcourseSnapshotV1, concourseWaitCopy } from './contracts.js'
import { OLDER_CHATS_ROW_PREFIX, olderChatsCensus } from '../concourse-model/concourseSnapshot.js'
import { PARKED_CAP } from '../boot-face/bootCardFacts.js'
import { deriveGitOffer, gitOfferFolderHeld, type GitOfferV1 } from './GitOfferCard.js'
import { keyHintLabel } from '../widgets/keyHintLabel.js'
import { NEW_SESSION_ROW_ID, ROW_PEEK_DESIRED_ROWS, switchboardGeometry } from './ConcourseLayout.js'
import { effectiveSeatCeiling } from '../../daemon/concourse-workers/concourseWorkers.js'
import { compactSteerable } from './compactBoard.js'
import { isPathTrusted } from '../../platform/settings/config.js'
import { getCwd } from '../../platform/files/cwd.js'
import { basename } from 'node:path'
import type { ConcourseCapsuleV2 } from './screen/capsule.js'
import { useConcourseFrame } from './screen/useConcourseFrame.js'
import { useConcourseFilter } from './screen/useConcourseFilter.js'
import { useConcoursePanes } from './screen/useConcoursePanes.js'
import { useConcourseRail } from './screen/useConcourseRail.js'
import { useConcourseSelection } from './screen/useConcourseSelection.js'
import { useConcourseMarks } from './screen/useConcourseMarks.js'
import { useConcourseDraft } from './screen/useConcourseDraft.js'
import { useConcourseCloseChord } from './screen/useConcourseCloseChord.js'
import { concourseRowControls } from './screen/rowControls.js'
import { useConcourseAsks } from './screen/useConcourseAsks.js'
import { useConcourseRowLine } from './screen/useConcourseRowLine.js'
import { useConcourseGeometry } from './screen/useConcourseGeometry.js'
import { useConcourseRegions } from './screen/useConcourseRegions.js'
import { useConcourseKeys } from './screen/useConcourseKeys.js'
import { useConcourseFaces } from './screen/useConcourseFaces.js'
import { concourseFullTree } from './screen/fullTree.js'
import { concourseStage } from './screen/stage.js'
export { broadcastFaceOf, broadcastSummaryOf, liveComposerGateOf, liveComposerPaintOf } from './screen/composerGate.js'
export { armSignInPickerReturn, consumeSignInPickerReturn } from './screen/signInPicker.js'

let presentationCapsule: ConcourseCapsuleV2 | null = null
export function _resetConcourseCapsuleForTesting(): void {
  presentationCapsule = null
}

export function ConcourseScreen({
  snapshot,
  callbacks,
  degraded = false,
  controlNotes,
  reducedStage = false,
}: {
  snapshot: ConcourseSnapshotV1
  callbacks: ConcourseCallbacks
  degraded?: boolean
  controlNotes?: Readonly<Record<string, import('./contracts.js').ControlNoteState>>
  reducedStage?: boolean
}): React.ReactNode {
  const { termCols, termRows, isCompact, compactProfile, compact, keyMapHint, splitActive, splitGeo, cols } = useConcourseFrame({ reducedStage })
  const { filtering, setFiltering, filter, setFilter, filterRef, editFilter, boardGroups, sessionRows, newSessionLine, newSessionLineNow } = useConcourseFilter({ snapshot, callbacks, reducedStage, presentationCapsule, compact })
  const { region, setRegion, helpOpen, setHelpOpen, helpOpenRef, groundPickerOpen, setGroundPickerOpen, groundPickerOpenRef } = useConcoursePanes({ reducedStage, presentationCapsule, compact })
  const { railSel, setRailSel, railSelRef, railIndex } = useConcourseRail({ snapshot, presentationCapsule })
  const { boardSel, setBoardSel, boardSelRef, compactParkNote, boardScroll, setBoardScroll, rowPeekOpen, setRowPeekOpen, rowPeekOpenRef, olderList, setOlderList, olderListRef } = useConcourseSelection({ presentationCapsule, compact, newSessionLine, sessionRows })
  const unfoldOlderList = (row: ConcourseRowV1): void => {
    const projectDir = row.sessionId.slice(OLDER_CHATS_ROW_PREFIX.length)
    const excluded = new Set(
      snapshot.groups
        .flatMap(g => g.rows)
        .filter(r => r.door === undefined && !r.sessionId.startsWith('dispatch:') && !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
        .map(r => r.sessionId),
    )
    const census = olderChatsCensus(projectDir, excluded, Date.now(), { entryCap: PARKED_CAP })
    if (census.readError !== undefined) {
      setNote({ tone: 'warning', text: `Older chats could not be read (${census.readError}) — check transcript folder permissions.` })
      return
    }
    const wouldAsk = Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, census.entries.length + 1))
    const wouldGrant = switchboardGeometry(
      cols,
      termRows,
      snapshot.needsYou.length,
      sessionRows.length + (newSessionLineNow() ? 1 : 0),
      boardGroupCount,
      liveDraftDesired,
      wouldAsk,
      region,
      thirdPaneRows,
    ).peekRows
    if (wouldGrant < 2) {
      setNote({ tone: 'muted', text: `no room to unfold the older chats — this height gives the list ${wouldGrant} row${wouldGrant === 1 ? '' : 's'}, it needs 2` })
      return
    }
    setRowPeekOpen(false)
    setOlderList({ entries: census.entries, total: census.total, at: 0 })
  }

  const { boardArmed, setBoardArmed, boardArmedRef, doorNote, doorNoteRef, clearDoorNote, showDoorNote, markedIds, setMarkedIds, markedIdsRef, markedRows, markedRowsOf, toggleMark, rowPick, setRowPick, rowPickRef, modelDefaultOpen, setModelDefaultOpen, modelDefaultOpenRef } = useConcourseMarks({ snapshot, boardSel, olderList, region, sessionRows, setOlderList })
  const selectSession = (sessionId: string): void => {
    if (sessionId === boardSelRef.current) return
    boardSelRef.current = sessionId
    setBoardSel(sessionId)
    setBoardScroll(null)
    if (sessionId !== NEW_SESSION_ROW_ID) callbacks.peekSession(sessionId)
  }
  const moveBoardSelection = (dir: 1 | -1): void => {
    if (sessionRows.length === 0) return
    const lineShown = newSessionLineNow()
    const current = boardSelRef.current
    if (lineShown && current === NEW_SESSION_ROW_ID) {
      if (dir === 1) selectSession(sessionRows[0]!.sessionId)
      return
    }
    const at = Math.max(0, sessionRows.findIndex(r => r.sessionId === current))
    if (lineShown && at === 0 && dir === -1) {
      selectSession(NEW_SESSION_ROW_ID)
      return
    }
    const next = Math.min(sessionRows.length - 1, Math.max(0, at + dir))
    const row = sessionRows[next]
    if (row && row.sessionId !== current) selectSession(row.sessionId)
  }

  const { liveDraft, setLiveDraft, liveDraftRef, liveUndoRef, editLiveDraft, broadcastArmed, setBroadcastArmed, broadcastArmedRef, note, setNote, liveNote, setLiveNote, composeContext, setComposeContext, composeContextRef, liveComposerGate, sendLive } = useConcourseDraft({ snapshot, callbacks, reducedStage, boardSel, boardSelRef, markedIds, markedRowsOf, sessionRows })
  const closeChordBlocked = (): boolean =>
    callbacks.daemonOfferArmed?.() === true ||
    helpOpenRef.current ||
    filtering ||
    boardModalOwner({
      capacityAsk: capacityAskRef.current,
      trustAsk: trustAskRef.current !== null,
      groundPickerOpen: groundPickerOpenRef.current,
      rowPick: rowPickRef.current !== null,
      modelDefault: modelDefaultOpenRef.current,
      gitOffer: gitOfferRef.current !== undefined,
    }) !== null

  const modalFactsNow = (): BoardModalFactsV1 => ({
    capacityAsk: capacityAskRef.current,
    trustAsk: trustAskRef.current !== null,
    groundPickerOpen: groundPickerOpenRef.current,
    rowPick: rowPickRef.current !== null,
    gitOffer: gitOfferRef.current !== undefined,
    helpOpen: helpOpenRef.current,
  })

  const { closeChordStage } = useConcourseCloseChord({ callbacks, boardSelRef, closeChordBlocked, sessionRows, setNote })
  const { rowControlSel, rowControlRefused, rowPauseToggle, rowStop, rowArchive, selectedIsDoor } = concourseRowControls({ callbacks, boardSelRef, sessionRows })
  const enterSession = (sessionId: string, opts: { pointer?: boolean } = {}): void => {
    if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      const open = olderListRef.current
      if (open === null) {
        const row = sessionRows.find(r => r.sessionId === sessionId)
        if (row !== undefined) unfoldOlderList(row)
        return
      }
      const pick = open.entries[Math.max(0, Math.min(open.entries.length - 1, open.at))]
      if (pick === undefined) {
        setOlderList(null)
        return
      }
      if (callbacks.resumeOlderChat === undefined) {
        setNote({ tone: 'muted', text: 'no resume door on this stage — /sessions from the boot face lists everything' })
        return
      }
      setOlderList(null)
      callbacks.resumeOlderChat(pick.sessionId, pick.transcriptPath, pick.title)
      return
    }
    if (sessionId.startsWith('dispatch:')) {
      const row = sessionRows.find(r => r.sessionId === sessionId)
      const line =
        row?.waitReason === undefined || row.waitReason === 'seat'
          ? `queued · ${snapshot.counts.live}/${effectiveSeatCeiling()} busy`
          : `queued — ${concourseWaitCopy(row.waitReason, row.waitDetail)}`
      setNote({ tone: 'muted', text: `${line} · m queues a message` })
      return
    }
    const door = sessionRows.find(r => r.sessionId === sessionId)?.door
    if (door !== undefined) {
      if (door.kind === 'switch-project') pickGround(door.dir)
      else setGroundPickerOpen(true)
      return
    }
    const parked = sessionRows.find(r => r.sessionId === sessionId)?.state === 'parked'
    if (!reducedStage && !parked && opts.pointer !== true && boardArmedRef.current !== sessionId) {
      boardArmedRef.current = sessionId
      setBoardArmed(sessionId)
      return
    }
    boardArmedRef.current = null
    setBoardArmed(null)
    callbacks.enterSession(sessionId)
  }
  const compactSteerOrEnter = (sel: ConcourseRowV1): void => {
    if (compact && compactSteerable(sel, { reduced: reducedStage, olderPrefix: OLDER_CHATS_ROW_PREFIX })) {
      boardArmedRef.current = sel.sessionId
      setBoardArmed(sel.sessionId)
      setRegion('live')
      return
    }
    enterSession(sel.sessionId)
  }

  const gitOffer = useMemo<GitOfferV1 | undefined>(() => {
    const derived = deriveGitOffer(snapshot.needsYou)
    return derived !== undefined ? { ...derived, folderHeld: gitOfferFolderHeld(snapshot, derived.folder) } : undefined
  }, [snapshot])
  const gitOfferRef = useRef<GitOfferV1 | undefined>(gitOffer)
  gitOfferRef.current = gitOffer

  const takeObligationDoor = (o: ConcourseSnapshotV1['needsYou'][number]): void => {
    const home = o.foreignProject
    if (home !== undefined) {
      if (isPathTrusted(home.dir)) applyGround(home.dir)
      else
        setNote({
          tone: 'muted',
          text: `kept on ${basename(getCwd()) || getCwd()} — ${home.name} stays untrusted ${keyHintLabel('(⌃g trusts it)')} · opening the chat anyway`,
        })
    }
    callbacks.openObligation(o.obligationId)
  }
  const openObligationOrDoor = (obligationId: string): void => {
    const o = snapshot.needsYou.find(x => x.obligationId === obligationId)
    if (o !== undefined && o.foreignProject !== undefined) takeObligationDoor(o)
    else callbacks.openObligation(obligationId)
  }

  const beginAnswer = (obligationId: string): void => {
    const o = snapshot.needsYou.find(x => x.obligationId === obligationId)
    if (!o) return
    if (o.foreignProject !== undefined) {
      takeObligationDoor(o)
      return
    }
    if (reducedStage) {
      callbacks.openObligation(obligationId)
      return
    }
    const ref = o.ref ?? ''
    if (ref.startsWith('permission:git-init:')) return
    if (ref.startsWith('permission:')) {
      openObligationOrDoor(obligationId)
      return
    }
    setComposeContext({ kind: 'answer', obligationId, title: o.question })
    setRegion('live')
  }

  const { capacityAsk, capacityAskRef, trustAsk, trustAskRef, applyGround, pickGround, answerTrustAsk, answerCapacityAsk } = useConcourseAsks({ callbacks, setGroundPickerOpen, setNote })
  const { pastGate, peekSelRow, peekLive, rowControlNote, closeChordStaged, selectedRowLineOf } = useConcourseRowLine({ callbacks, controlNotes, boardArmed, boardSel, capacityAsk, closeChordStage, filtering, gitOffer, groundPickerOpen, helpOpen, liveComposerGate, liveDraft, markedRows, modelDefaultOpen, rowPeekOpen, rowPick, sessionRows, trustAsk })
  const { olderRows, thirdPaneRows, liveDraftDesired, boardGroupCount, rowLineWidth, selectedRowLine, chipRows, geo, compactGeo } = useConcourseGeometry({ snapshot, callbacks, reducedStage, boardGroups, cols, compactProfile, liveDraft, newSessionLine, olderList, region, rowPeekOpen, selectedRowLineOf, sessionRows, termCols, termRows })
  const { regionsInOrder } = useConcourseRegions({ snapshot, reducedStage, compact, geo, olderList, region, setNote, setOlderList, setRegion, splitActive, termCols, termRows })
  const capsuleRef = useRef<ConcourseCapsuleV2 | null>(null)
  capsuleRef.current = { region, filtering, filter, boardSel, railSel, boardScroll }
  useClaim(() => {
    presentationCapsule = null
    return () => {
      presentationCapsule = capsuleRef.current
    }
  }, [])

  useConcourseKeys({ snapshot, callbacks, degraded, reducedStage, answerCapacityAsk, answerTrustAsk, beginAnswer, boardArmedRef, boardSelRef, broadcastArmedRef, capacityAskRef, clearDoorNote, compact, compactGeo, compactSteerOrEnter, composeContextRef, doorNoteRef, editFilter, editLiveDraft, enterSession, filterRef, filtering, geo, gitOfferRef, groundPickerOpenRef, helpOpenRef, liveComposerGate, liveDraftRef, liveUndoRef, markedIdsRef, markedRowsOf, modelDefaultOpenRef, moveBoardSelection, newSessionLineNow, olderListRef, openObligationOrDoor, pastGate, railSelRef, region, regionsInOrder, rowArchive, rowControlRefused, rowControlSel, rowPauseToggle, rowPeekOpenRef, rowPickRef, rowStop, selectedIsDoor, sendLive, sessionRows, setBoardArmed, setBoardScroll, setBroadcastArmed, setComposeContext, setFilter, setFiltering, setGroundPickerOpen, setHelpOpen, setLiveDraft, setLiveNote, setMarkedIds, setModelDefaultOpen, setNote, setOlderList, setRailSel, setRegion, setRowPeekOpen, setRowPick, showDoorNote, splitActive, termCols, termRows, toggleMark, trustAskRef, unfoldOlderList })
  const { t, mirrorSlot, liveComposerFace, compactNote } = useConcourseFaces({ snapshot, controlNotes, reducedStage, boardSel, broadcastArmed, compact, compactGeo, compactParkNote, composeContext, editLiveDraft, enterSession, geo, isCompact, liveComposerGate, liveDraft, liveDraftRef, liveNote, markedRows, note, region, rowControlNote, sessionRows, setRegion, splitGeo })
  const fullTree = concourseFullTree({ snapshot, callbacks, degraded, controlNotes, reducedStage, beginAnswer, boardArmed, boardGroups, boardScroll, boardSel, chipRows, closeChordStaged, enterSession, filter, filtering, geo, groundPickerOpen, keyMapHint, liveComposerFace, liveDraft, liveDraftDesired, markedIds, mirrorSlot, modalFactsNow, olderList, olderRows, openObligationOrDoor, peekLive, peekSelRow, railIndex, railSelRef, region, rowLineWidth, rowPeekOpen, selectSession, selectedRowLine, setGroundPickerOpen, setOlderList, setRailSel, setRegion, splitGeo, t, thirdPaneRows })
  return concourseStage({ snapshot, callbacks, reducedStage, answerCapacityAsk, answerTrustAsk, boardSel, capacityAsk, cols, compactNote, compactProfile, compactSteerOrEnter, doorNote, filter, filtering, fullTree, geo, gitOffer, groundPickerOpen, helpOpen, liveComposerFace, liveDraft, liveDraftDesired, mirrorSlot, modelDefaultOpen, pickGround, region, rowPick, selectSession, sessionRows, setGroundPickerOpen, setModelDefaultOpen, setRegion, setRowPick, splitActive, splitGeo, t, termCols, termRows, trustAsk })
}
