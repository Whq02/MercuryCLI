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

// ============================================================================
//  The focused chat's status row — the ONE line a hopped-into session adds
//  to the cockpit. Every session is a full chat; a session you hop into
//  from the concourse gets the same cockpit as the session you started at
//  boot (the same panes, rails, readouts, keys and commands, the same
//  consent card). What differs is this composer-adjacent row: the session's
//  own state read off its records (ready / working / stalled /
//  interrupting), the worktree it works on, and the way back — "⇧← back"
//  (the crumb is a click target).
//  No key lives here: esc rides the chat's own cancel handler through the
//  focused connector, ⇧← is the surface strip's own chord, the consent card
//  answers itself.
// ============================================================================

const subscribeFocusedSeat = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
function getFocusedSeatLive(): SessionLiveV1 {
  const c = getFocusedSessionConnector()
  return hasSeatLive(c) ? c.live() : IDLE_LIVE
}
/** A duration as the row speaks it: seconds under a minute, whole minutes
 *  past it (the row's repaint economy rides these words — a minute-old
 *  phase repaints once a minute, a young one once a second). */
export function statusDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m`
}

/** The row's state words from the liveness owner's facts — pure, so the
 *  copy has one spelling on the glass and under proof. Durations are facts
 *  and paint from ten seconds on; "stuck" is spoken only on the owner's
 *  verdict and names exactly what it saw. */
export function statusLine(live: SessionLiveV1, s: SeatStatusV1): string {
  // The interrupt's words claim exactly what the road does: the in-flight
  // request is torn down and every agent the turn waits on is stopped; a
  // second esc cuts the runner if the turn is still open a second later.
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

/** The session's identity as the attribution bridge keys on it: the slot's
 *  session and its naming — never the live clocks (a per-second key here
 *  would re-render the whole transcript tree's provider). */
function getFocusedSeatIdentityKey(): string {
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return ''
  const s = c.status()
  return `${c.sessionId()}|${s.title}|${s.projectLabel}|${s.branchLabel ?? ''}|${s.isolation ?? ''}`
}

/** The row's own key: its identity plus the very words it paints — the
 *  repaint economy keys on the owner's fact (a clock that has not moved a
 *  spoken second repaints nothing; the live channel's tick only re-reads). */
function getFocusedSeatStatusKey(): string {
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return ''
  const live = c.live()
  const s = c.status()
  return `${getFocusedSeatIdentityKey()}|${s.interrupting ? 1 : 0}|${s.hardStopping ? 1 : 0}|${live.inFlight ? 1 : 0}|${s.stuck ? 1 : 0}|${statusLine(live, s)}`
}

/** Coordinator-relayed messages wear their [Coordinator] plate in the chat
 *  exactly as in the mirror — the same ledger-digest classifier, provided
 *  over the whole transcript tree while a daemon-hosted session is the
 *  focused chat. Elsewhere: transparent. */
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

/** The focused chat's one status row. Paints nothing while the focused
 *  chat is the session you started at boot (its screen is unchanged). */
export function FocusedSessionStatusRow(): React.ReactNode {
  const t = useMercuryTokens()
  useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatStatusKey, getFocusedSeatStatusKey)
  const live = useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatLive, getFocusedSeatLive)
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return null
  const status: SeatStatusV1 = c.status()
  // THE LIVENESS LAW: the verdict is the owner's (SeatStatusV1.stuck — the
  // runner's own stream silent past its watchdog's warning half), never a
  // reading of the transcript file. The delivery law: a sent message lands
  // whatever the session is doing, so the state words never promise
  // holding — they say what the session is doing, and for how long.
  const stalled = status.stuck
  const line = statusLine(live, status)
  const worktree = status.isolation === 'worktree-isolated' && status.branchLabel !== undefined ? status.branchLabel : null
  // The stage-1 tag (L16: "new session · <project> · ready") already ends
  // with the project and the state this row paints after it — the row
  // read "new session · X · ready · X · ready — your words go…" on every
  // blank chat. One owner for those two words: the row's own segments.
  const stageOneTail = ` · ${status.projectLabel} · ready`
  const title = status.title.endsWith(stageOneTail) ? status.title.slice(0, -stageOneTail.length) : status.title
  return (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      {/* The glyph and the way back never shrink; the state words are the
          one segment that truncates when the terminal is narrow. */}
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
              {/* The leading space is the row's guaranteed gap: on a narrow
                  terminal the state words truncate, the way back never
                  touches them. */}
              {' '}
              {live.inFlight && !status.interrupting ? 'esc interrupts · ' : live.inFlight && !status.hardStopping ? 'esc again stops · ' : ''}{keyHintLabel('⇧← back')}{' '}
            </Text>
          )}
        </InteractiveRow>
      </Box>
    </Box>
  )
}
