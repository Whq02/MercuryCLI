import React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { AnimatedCritterArt } from '../../widgets/AnimatedCritterArt.js'
import { critterDefForKey } from '../../cockpit/critterData.js'
import { useSessionAccent } from '../../widgets/sessionAccent.js'
import { type ControlNoteState, controlNoteOf, concourseWaitCopy } from '../contracts.js'
import { clampCaret, draftWindow, type LineDraft } from '../lineDraft.js'
import { OLDER_CHATS_ROW_PREFIX } from '../../concourse-model/concourseSnapshot.js'
import { SessionMirror } from '../SessionMirror.js'
import { GLYPH } from '../../theme/glyphs.js'
import { ConcourseComposer, composerSendKeysHint } from '../ConcourseStrips.js'
import type { CompactFootNote } from '../CompactConcourse.js'
import { COMPACT_DOOR_REST_HINT } from '../compactBoard.js'
import { NL } from './useConcourseDraft.js'
import { broadcastFaceOf, liveComposerPaintOf } from './composerGate.js'
import type { Draft, Filter, Frame, Geometry, Marks, Panes, RowLine, ScreenDoors, ScreenProps, Selection } from './state.js'

export function useConcourseFaces({ snapshot, controlNotes, reducedStage, boardSel, broadcastArmed, compact, compactGeo, compactParkNote, composeContext, editLiveDraft, enterSession, geo, isCompact, liveComposerGate, liveDraft, liveDraftRef, liveNote, markedRows, note, region, rowControlNote, sessionRows, setRegion, splitGeo }: Pick<ScreenProps, 'snapshot' | 'controlNotes' | 'reducedStage'> & Pick<Selection, 'boardSel' | 'compactParkNote'> & Pick<Draft, 'broadcastArmed' | 'composeContext' | 'editLiveDraft' | 'liveComposerGate' | 'liveDraft' | 'liveDraftRef' | 'liveNote' | 'note'> & Pick<Frame, 'compact' | 'isCompact' | 'splitGeo'> & Pick<Geometry, 'compactGeo' | 'geo'> & Pick<ScreenDoors, 'enterSession'> & Pick<Marks, 'markedRows'> & Pick<Panes, 'region' | 'setRegion'> & Pick<RowLine, 'rowControlNote'> & Pick<Filter, 'sessionRows'>) {
  const t = useMercuryTokens()
  const residentAccent = useSessionAccent()
  const residentDef = React.useMemo(
    () => ({
      ...critterDefForKey(residentAccent.key),
      hue: residentAccent.accent,
      hueDeep: residentAccent.accentDeep,
    }),
    [residentAccent.key, residentAccent.accent, residentAccent.accentDeep],
  )
  const mirrorSlot = (rows: number, width: number, bare = false): React.ReactNode => {
    const anySessions = sessionRows.length > 0 || snapshot.counts.live > 0
    if (!anySessions) {
      return (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden">
          {!isCompact && rows >= 8 && width >= 20 ? (
            <AnimatedCritterArt def={residentDef} square specimen />
          ) : null}
          <Text color={t.textMuted}>no sessions running</Text>
        </Box>
      )
    }
    const sel = sessionRows.find(r => r.sessionId === boardSel)
    if (!sel || sel.sessionId.startsWith('dispatch:') || sel.workspaceDir === undefined) {
      const openNote = controlNotes?.['board:open']
      const noteRow = (() => {
        if (openNote === undefined) return null
        const n = controlNoteOf(openNote)
        return n.state === 'refused' || n.state === 'failed' ? (
          <Text color={t.failureText} wrap="truncate-end">
            ✕ {n.reason ?? 'refused'}
            {n.next !== undefined ? ` · ${n.next}` : ''}
          </Text>
        ) : n.state === 'applied' ? (
          <Text color={t.success} wrap="truncate-end">
            ✓ {n.reason ?? 'entering'}
          </Text>
        ) : (
          <Text color={t.textInstruction} wrap="truncate-end">
            {n.reason ?? 'working…'}
          </Text>
        )
      })()
      return (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" paddingX={1} overflow="hidden">
          {noteRow}
          <Text color={t.textInstruction} wrap="truncate-end">
            {sel && sel.sessionId.startsWith('dispatch:')
              ? sel.waitReason === 'repo-held'
                ? `repo held by ${sel.waitDetail ?? 'a live session'} — free the checkout to start this one`
                : sel.waitReason === 'unblocked'
                  ? `${concourseWaitCopy(sel.waitReason, sel.waitDetail)} · m queues a message`
                  : sel.waitReason === 'no-repository' || sel.waitReason === 'unborn-head'
                    ? 'needs git — say yes to the offer and it starts on its own'
                    : `${concourseWaitCopy(sel.waitReason, sel.waitDetail)} — it starts when one frees · m queues a message`
              : sel?.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) === true
                ? region === 'list' || region === 'live'
                  ? "the project's older chats — ↵ unfolds them on the board; a pick brings one back"
                  : "the project's older chats — tab to the list, ↵ unfolds them; a pick brings one back"
              : sel?.door !== undefined
                ? sel.door.kind === 'switch-project'
                  ? `${sel.title} — ↵ switches the board to ${sel.projectLabel}; they keep running either way`
                  : `${sel.title} — ↵ opens the repo picker`
                : sel?.state === 'parked'
                  ? 'parked — ↵ brings it back'
                  : 'select a session to mirror its chat · ↑↓'}
          </Text>
        </Box>
      )
    }
    const peekFacts = snapshot.peek !== null && snapshot.peek.sessionId === sel.sessionId ? snapshot.peek : null
    const modelLabel = sel.modelLabel ?? peekFacts?.modelLabel ?? snapshot.newSession.modelOptions?.find(o => o.modelId === sel.modelId)?.displayName
    const effortLabel = sel.effortLabel ?? (peekFacts !== null ? snapshot.context.effortLabel : undefined)
    return (
      <SessionMirror
        sessionId={sel.sessionId}
        workspaceId={sel.workspaceDir}
        title={sel.title}
        titleFacts={[sel.projectLabel, modelLabel, effortLabel].filter((f): f is string => f !== undefined && f.length > 0)}
        paneRows={rows}
        paneWidth={width}
        {...(splitGeo !== null
          ? { wheelBand: [0, splitGeo.dividerCol - 1] as [number, number] }
          : compactGeo !== null
            ? { wheelBand: [compactGeo.live.x0 + 1, compactGeo.live.x1 + 1] as [number, number] }
            : geo.profile === 'wide' && !geo.constrained
              ? { wheelBand: geo.liveCols }
              : {})}
        {...(compactGeo !== null
          ? { wheelRows: [compactGeo.live.y0 + 2, compactGeo.live.y1] as [number, number] }
          : !geo.constrained
            ? { wheelRows: [geo.mirrorBand[0] + 1, geo.mirrorBand[1] - 1] as [number, number] }
            : {})}
        focused={region === 'live'}
        bare={bare}
        onEnter={() => enterSession(sel.sessionId, { pointer: true })}
        state={sel.state}
        {...(sel.nowLabel !== undefined ? { nowLabel: sel.nowLabel } : {})}
        {...(sel.nowLive === true ? { nowLive: true } : {})}
        {...(controlNotes?.['board:open'] !== undefined
          ? { note: controlNotes['board:open'] }
          : {})}
      />
    )
  }

  const selectedRow = sessionRows.find(r => r.sessionId === boardSel)
  const liveKeysHint =
    liveDraft.text.length === 0
      ? reducedStage
        ? '↵ enter session · tab panes'
        : '↵↵ enter session · tab panes'
      : selectedRow?.state === 'working'
        ? composerSendKeysHint(true)
        : undefined
  const contextLine =
    composeContext.kind === 'answer'
      ? { tone: 'warning' as const, text: `answer · ${composeContext.title} · ↵ delivers & resumes · esc cancels` }
      : composeContext.kind === 'rename'
        ? { tone: 'info' as const, text: `rename · ${composeContext.title} · type the new title · ↵ saves · esc cancels` }
        : broadcastArmed
          ?
            { tone: 'warning' as const, text: `broadcast · sends to ${markedRows.length} sessions · ↵ again sends · esc cancels` }
          : null

  const caretFromClick = (d: LineDraft, bandRows: number, visibleRow: number, col: number): number => {
    const lines = d.text.split(NL)
    const w = draftWindow(d, bandRows)
    const li = Math.max(
      0,
      Math.min(lines.length - 1, w.windowStart + Math.max(0, visibleRow - (w.hiddenAbove > 0 ? 1 : 0))),
    )
    let caret = 0
    for (let i = 0; i < li; i++) caret += (lines[i]?.length ?? 0) + 1
    caret += Math.max(0, Math.min(lines[li]?.length ?? 0, col))
    return caret
  }
  const onLiveComposerClick = (visibleRow: number, col: number): void => {
    if (reducedStage) return
    setRegion('live')
    const caret = caretFromClick(liveDraftRef.current, Math.max(1, geo.liveComposerRows - 3), visibleRow, col)
    editLiveDraft(dd => ({ text: dd.text, caret: clampCaret(dd.text, caret) }))
  }

  const compactDoorSelected = compact && selectedRow?.door !== undefined
  const liveComposerFace = (bandRows: number, width: number): React.ReactNode => {
    const face = broadcastFaceOf(markedRows.length)
    const g = compactDoorSelected
      ? { ok: true as const, placeholder: COMPACT_DOOR_REST_HINT }
      : liveComposerGate(selectedRow, region)
    const boardNote = compact ? null : note
    const paint = liveComposerPaintOf(g, liveNote ?? boardNote)
    return (
      <ConcourseComposer
        minimal={geo.constrained && !compact}
        foot={!compact}
        width={width}
        bandRows={bandRows}
        focused={region === 'live'}
        draft={liveDraft}
        pending={false}
        note={compact ? null : face !== null ? liveNote ?? boardNote : paint.note}
        restHint={face !== null ? face.placeholder : paint.restHint}
        contextLine={compact ? null : contextLine}
        onComposerClick={onLiveComposerClick}
        {...(!compact && controlNotes?.['strip:composer'] !== undefined
          ? { composerNote: controlNotes['strip:composer'] }
          : {})}
        {...(liveKeysHint !== undefined ? { keysHint: liveKeysHint } : {})}
      />
    )
  }
  const compactNote = ((): CompactFootNote | null => {
    if (!compact) return null
    if (contextLine !== null) return contextLine
    const noteOf = (state: ControlNoteState | undefined): CompactFootNote | null => {
      if (state === undefined) return null
      const n = controlNoteOf(state)
      const what = n.reason ?? n.state
      const next = n.next !== undefined ? ` · ${n.next}` : ''
      if (n.state === 'applied') return { tone: 'success', text: `${GLYPH.ok} ${what}` }
      if (n.state === 'pending') return { tone: 'info', text: what }
      if (n.state === 'held') return { tone: 'warning', text: `${GLYPH.pending} ${what}${next}` }
      return { tone: 'failure', text: `${GLYPH.fail} ${what}${next}` }
    }
    const face = broadcastFaceOf(markedRows.length)
    const gateNote = liveComposerPaintOf(liveComposerGate(sessionRows.find(r => r.sessionId === boardSel), region), liveNote).note
    return (
      noteOf(controlNotes?.['strip:composer']) ??
      noteOf(controlNotes?.['board:open']) ??
      noteOf(rowControlNote) ??
      compactParkNote ??
      (face !== null ? liveNote : compactDoorSelected ? null : gateNote) ??
      note
    )
  })()
  return { t, mirrorSlot, liveComposerFace, compactNote }
}
