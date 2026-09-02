import React from 'react'
import { Text } from '../../ink.js'
import { fireDeltaWords } from '../BootSaturnScreen.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { concourseWaitCopy, type ConcourseRowV1 } from './contracts.js'
import { askTileCopy, useLiveTile } from './liveTiles.js'

// ============================================================================
//  LiveNowCell — the board row's NOW cell ALIVE:
//  the one cell that shows what the session is doing right now.
//
//  Paint order (line 6 — the ask never hides behind scroll):
//    1. a parked ask                → "asks: <question>"  (warning ink)
//    2. the streaming reply        → its last line, scrolling (muted)
//    3. the running tool           → "running <tool · hint>" (muted)
//    4. settled/idle/queued/still  → EXACTLY the base board's bytes (the
//       snapshot summary / the queued wait copy) — an idle tile is still.
//
//  Degraded (line 7): a dim '·' leads the snapshot summary; the footer
//  carries the one sentence. The cell is memoized and its subscription is
//  content-keyed — a repaint happens only when THIS session's line moved
//  (the CALM law; the board around it never re-renders for a tile).
// ============================================================================

export const LiveNowCell = React.memo(function LiveNowCell({
  row,
  ask,
}: {
  row: ConcourseRowV1
  /** The session's oldest open needs-you question, when one is parked. */
  ask?: string | undefined
}): React.ReactNode {
  const t = useMercuryTokens()
  const live = row.state === 'working' || row.state === 'needs-you' || row.state === 'starting'
  const { now, degraded } = useLiveTile(row.sessionId, row.workspaceDir, live)
  const workflowsLead = (trail: boolean): React.ReactNode =>
    row.workflowsAllowed === true ? (
      <Text color={t.textSecondary}>workflows allowed{trail ? ' · ' : ''}</Text>
    ) : null
  // SATURN (the banked spec's concourse surfacing): the standing next-fire
  // tag — the workflows tag's exact grammar; present exactly when the row
  // carries the projection's fact.
  const hasNextFire = row.scheduleNextFireMs !== undefined
  const nextFireLead = (trail: boolean): React.ReactNode =>
    row.scheduleNextFireMs !== undefined ? (
      <Text color={t.textSecondary}>next fire {fireDeltaWords(row.scheduleNextFireMs, Date.now())}{trail ? ' · ' : ''}</Text>
    ) : null
  // ── the queued row: its own reason, byte-for-byte the base board ──
  if (row.state === 'queued') {
    return (
      <Text wrap="truncate-end">
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.textMuted}>{concourseWaitCopy(row.waitReason, row.waitDetail)}</Text>
      </Text>
    )
  }
  // ── needs-you first (line 6): the ask outranks whatever streams ──
  if (ask !== undefined && ask.length > 0) {
    const question = askTileCopy(row.title, ask)
    return (
      <Text wrap="truncate-end">
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.warning}>asks: {question}</Text>
      </Text>
    )
  }
  // ── a needs-you row WITHOUT a parked ask: the row's own line — the
  //    crash reason (the session-end visibility law) or the snapshot
  //    summary — never a stale stream frozen over a session that needs
  //    the operator. Warning ink: the row is asking for eyes. ──
  if (row.state === 'needs-you') {
    return (
      <Text wrap="truncate-end">
        {workflowsLead(hasNextFire || (row.nowLabel ?? '') !== '')}
        {nextFireLead((row.nowLabel ?? '') !== '')}
        <Text color={t.warning}>{row.nowLabel ?? ''}</Text>
      </Text>
    )
  }
  // ── the live line (lines 1–2) ──
  if (live && !degraded && now.kind !== 'still') {
    // Streaming keeps its NEWEST words on screen (truncate-start — the
    // scroll); a tool/settled line leads with its head as every label does.
    return (
      <Text wrap={now.kind === 'streaming' ? 'truncate-start' : 'truncate-end'}>
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.textMuted}>{now.kind === 'tool' ? `running ${now.line}` : now.line}</Text>
      </Text>
    )
  }
  // ── still / degraded: the snapshot summary (the base bytes), the
  //    degrade marked with one dim leading dot (line 7) ──
  return (
    <Text wrap="truncate-end">
      {workflowsLead(hasNextFire || (row.nowLabel ?? '') !== '' || (live && degraded))}
      {nextFireLead((row.nowLabel ?? '') !== '' || (live && degraded))}
      {live && degraded ? <Text color={t.textMuted}>· </Text> : null}
      <Text color={t.textMuted}>{row.nowLabel ?? ''}</Text>
    </Text>
  )
})
