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
  focused: boolean
  snapshot: ConcourseSnapshotV1
  onEnterFull: () => void
  onNewSession: () => void
  wheelBand?: [number, number]
}): React.ReactNode {
  const t = useMercuryTokens()
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
