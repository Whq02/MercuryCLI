import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { enterConcourse } from '../context/surfaceRoute.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive, IDLE_LIVE, type SeatStatusV1, type SessionLiveV1 } from '../services/engine-connector/seatLive.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { keyHintLabel } from './mercury-ui/keyHintLabel.js'
import { WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { AttachedAttributionContext } from './messages/TranscriptNameplate.js'
import { useCoordinatorAttribution } from './concourse/workerTranscriptFold.js'


const subscribeFocusedSeat = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
function getFocusedSeatLive(): SessionLiveV1 {
  const c = getFocusedSessionConnector()
  return hasSeatLive(c) ? c.live() : IDLE_LIVE
}
export function statusDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m`
}

export function statusLine(live: SessionLiveV1, s: SeatStatusV1): string {
  if (s.hardStopping) return 'stopping — the runner is cut if the turn is still open in a second'
  if (s.interrupting) return 'interrupting — the request is torn down · esc again forces a stop'
  if (!live.inFlight) return 'ready'
  if (live.phase === 'waiting') {
    return `waiting on ${live.agentsWaiting} agent${live.agentsWaiting === 1 ? '' : 's'} · esc stops them`
  }
  if (s.stuck && s.quietMs !== null && s.watchdogMs !== null) {
    return `no stream events for ${statusDuration(s.quietMs)} — the session may be stuck (the watchdog aborts at ${statusDuration(s.watchdogMs)})`
  }
  const word =
    live.phase === 'thinking' ? 'thinking' : live.phase === 'tool' ? 'running a tool' : live.phase === 'compacting' ? 'compacting' : 'replying'
  if (live.phase === 'responding') return word
  const clock = s.phaseMs !== null && s.phaseMs >= 10_000 ? ` for ${statusDuration(s.phaseMs)}` : ''
  const budget = live.phase === 'tool' && s.toolBudgetMs !== null ? ` (its own timeout at ${statusDuration(s.toolBudgetMs)})` : ''
  return `${word}${clock}${budget}`
}

function getFocusedSeatIdentityKey(): string {
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return ''
  const s = c.status()
  return `${c.sessionId()}|${s.title}|${s.projectLabel}|${s.branchLabel ?? ''}|${s.isolation ?? ''}`
}

function getFocusedSeatStatusKey(): string {
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return ''
  const live = c.live()
  const s = c.status()
  return `${getFocusedSeatIdentityKey()}|${s.interrupting ? 1 : 0}|${s.hardStopping ? 1 : 0}|${live.inFlight ? 1 : 0}|${s.stuck ? 1 : 0}|${statusLine(live, s)}`
}

export function SwitchboardAttributionProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatIdentityKey, getFocusedSeatIdentityKey)
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return <>{children}</>
  const sessionId = c.sessionId()
  return (
    <SwitchboardAttributionBridge key={sessionId} sessionId={sessionId}>
      {children}
    </SwitchboardAttributionBridge>
  )
}

function SwitchboardAttributionBridge({
  sessionId,
  children,
}: {
  sessionId: string
  children: React.ReactNode
}): React.ReactNode {
  const classify = useCoordinatorAttribution(sessionId, null)
  return <AttachedAttributionContext.Provider value={classify}>{children}</AttachedAttributionContext.Provider>
}

export function FocusedSessionStatusRow(): React.ReactNode {
  const t = useMercuryTokens()
  useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatStatusKey, getFocusedSeatStatusKey)
  const live = useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatLive, getFocusedSeatLive)
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return null
  const status: SeatStatusV1 = c.status()
  const stalled = status.stuck
  const line = statusLine(live, status)
  const worktree = status.isolation === 'worktree-isolated' && status.branchLabel !== undefined ? status.branchLabel : null
  const stageOneTail = ` · ${status.projectLabel} · ready`
  const title = status.title.endsWith(stageOneTail) ? status.title.slice(0, -stageOneTail.length) : status.title
  return (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      {
}
      <Box flexShrink={0}>
        <WorkingGlyph color={stalled ? t.textMuted : live.inFlight ? t.info : t.success} active={live.inFlight && !stalled} />
      </Box>
      <Text wrap="truncate-end">
        <Text color={t.accent} bold>
          {' '}
          {title}
        </Text>
        <Text color={t.textMuted}> · {status.projectLabel} · </Text>
        <Text color={t.textInstruction}>{line}</Text>
        {worktree !== null ? (
          <Text>
            <Text color={t.textMuted}> · </Text>
            <Text color={t.info}>{GLYPH.branch} </Text>
            <Text color={t.infoText}>{worktree}</Text>
          </Text>
        ) : null}
      </Text>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <InteractiveRow id="switchboard:status:back" directActivate hoverStyle="chrome-ink" onActivate={() => enterConcourse()}>
          {hover => (
            <Text color={hover ? t.info : t.textMuted} bold={hover}>
              {
}
              {' '}
              {live.inFlight && !status.interrupting ? 'esc interrupts · ' : live.inFlight && !status.hardStopping ? 'esc again stops · ' : ''}{keyHintLabel('⇧← back')}{' '}
            </Text>
          )}
        </InteractiveRow>
      </Box>
    </Box>
  )
}
