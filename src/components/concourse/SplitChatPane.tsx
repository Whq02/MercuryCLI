import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
} from '../../services/engine-connector/focusedConnector.js'
import type { ConcourseSnapshotV1 } from './contracts.js'
import { SessionMirror } from './SessionMirror.js'

// ============================================================================
//  SplitChatPane — the CHAT SIDE of the split frame (the split-view sheet,
//  item 3). Hosts the FOCUSED session through the same bridge the full chat
//  uses: THE one focused slot (engine-connector/focusedConnector) names the
//  session, and the landed SessionMirror paints it through the real
//  renderer pipeline — never a second connector, never a second session
//  host, never a composer (the composer/caret story inside the pane lives
//  elsewhere; v1 demands only that the pane's key ownership be visible).
//
//  · A session holds the slot ⇒ its live chat, with the mirror's own
//    "↵ enter session" affordance meaning THE FULL CHAT here (the same
//    enter journey shift+→ rides — the slot already points at it, so the
//    move is pure route, no hop).
//  · No focused session ⇒ the board's own New Session grammar
//    ("↵ new session · <project>") and nothing else.
//  · The header row is the pane-focus truth at a glance: which pane owns
//    the keys, and the tab that moves them.
// ============================================================================

export function SplitChatPane({
  rows,
  width,
  focused,
  snapshot,
  onEnterFull,
  onNewSession,
  wheelBand,
}: {
  rows: number
  width: number
  /** The chat pane owns the keys (region 'chat' in the extended Tab ring). */
  focused: boolean
  /** The board's snapshot — the focused session's row facts (workspace,
   *  title, state) come from here; the ★ carry-over law keeps the focused
   *  chat on the board even cross-project. */
  snapshot: ConcourseSnapshotV1
  /** ↵ with a focused session — the full chat (the route move). */
  onEnterFull: () => void
  /** ↵ with no focused session — the one birth door (the board's own New
   *  Session), staying in split. */
  onNewSession: () => void
  /** This pane's column band — forwarded to the
   *  mirror so the divider partitions the wheel. */
  wheelBand?: [number, number]
}): React.ReactNode {
  const t = useMercuryTokens()
  // The slot is the ONE truth: subscribe re-renders on every re-point,
  // release and landing edge; the snapshot value is the session id (or ''),
  // stable between re-points.
  const focusedId = useSyncExternalStore(
    subscribeFocusedSessionConnector,
    () => (hasFocusedSession() ? getFocusedSessionConnector().sessionId() : ''),
    () => '',
  )
  const row =
    focusedId === ''
      ? undefined
      : snapshot.groups.flatMap(g => g.rows).find(r => r.sessionId === focusedId)
  const header = (
    <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
      <Text color={focused ? t.info : t.textMuted} bold={focused} wrap="truncate-end">
        FOCUSED CHAT
      </Text>
      <Box flexGrow={1} />
      <Text color={focused ? t.textPrimary : t.textMuted} wrap="truncate-end">
        {focused ? 'tab board · s full board' : 'tab chat pane'}
      </Text>
    </Box>
  )
  if (focusedId === '') {
    // No focused session: the board's own New Session grammar and nothing
    // else (a landing in flight says so instead — the chat is milliseconds
    // from existing and must not offer a second birth).
    return (
      <Box flexDirection="column" height={rows} width={width} overflow="hidden">
        {header}
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden">
          {landingInFlight() ? (
            <Text color={t.textInstruction} wrap="truncate-end">
              opening the focused chat…
            </Text>
          ) : (
            <InteractiveRow id="split:chat:new-session" directActivate hoverStyle="row-fill" onActivate={onNewSession}>
              {hover => (
                <Text wrap="truncate-end">
                  <Text color={hover || focused ? t.textPrimary : t.info}>↵ new session</Text>
                  <Text color={t.textMuted}> · {snapshot.context.projectLabel}</Text>
                </Text>
              )}
            </InteractiveRow>
          )}
        </Box>
      </Box>
    )
  }
  if (row === undefined || row.workspaceDir === undefined) {
    // The slot names a session the board cannot place yet (a birth's first
    // beat, a record between rebuilds) — the honest line, never a torn
    // mirror over an unknown workspace.
    return (
      <Box flexDirection="column" height={rows} width={width} overflow="hidden">
        {header}
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden">
          <Text color={t.textInstruction} wrap="truncate-end">
            the focused chat is coming onto the board…
          </Text>
          <Text color={t.textMuted} wrap="truncate-end">
            ↵ opens it whole
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" height={rows} width={width} overflow="hidden">
      {header}
      <SessionMirror
        idScope="split:chat:mirror"
        {...(wheelBand !== undefined ? { wheelBand } : {})}
        sessionId={row.sessionId}
        workspaceId={row.workspaceDir}
        title={row.title}
        paneRows={rows - 1}
        paneWidth={width}
        focused={focused}
        onEnter={onEnterFull}
        state={row.state}
        {...(row.nowLabel !== undefined ? { nowLabel: row.nowLabel } : {})}
      />
    </Box>
  )
}
