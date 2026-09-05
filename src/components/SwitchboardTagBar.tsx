import React, { useMemo, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { enterConcourse } from '../context/surfaceRoute.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive, IDLE_LIVE, type SeatStatusV1, type SessionLiveV1 } from '../services/engine-connector/seatLive.js'
import type { WorkRowV1 } from '../services/engine-connector/types.js'
import { escRungHint, escRungOf } from '../input-core/interruptArity.js'
import { crewAgentsOf, crewWaitingWords } from '../services/engine-connector/crewFacts.js'
import { workRowRuns, workWaitingWords } from '../services/engine-connector/workCounts.js'
import { requestWaitLine } from '../services/providers/streamIdleBudget.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateKeepingTail } from '../utils/truncate.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { keyHintLabel } from './mercury-ui/keyHintLabel.js'
import { useNowTick } from './mercury-ui/components.js'
import { focusedWorkflowRows, useFocusedWorkRows } from './tasks/useFocusedWork.js'
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

export function seatDisplayTitle(status: Pick<SeatStatusV1, 'title' | 'projectLabel'>): string {
  const stageOneTail = ` · ${status.projectLabel} · ready`
  const title = status.title.endsWith(stageOneTail) ? status.title.slice(0, -stageOneTail.length) : status.title
  return title.trim() === '' ? 'new session' : title
}

export type CrewClockV1 = {
  active: boolean
  line: string | null
}

type CrewSpan = { startedAt: number; endedAt: number | null; running: boolean }
type KindClock = { word: string; running: boolean; ms: number }

function crewSpansOf(rows: readonly WorkRowV1[]): { agents: CrewSpan[]; workflows: CrewSpan[] } {
  return {
    agents: crewAgentsOf(rows, null).map(a => ({ startedAt: a.startedAt, endedAt: a.endedAt, running: a.running })),
    workflows: focusedWorkflowRows(rows).map(r => ({ startedAt: r.startTime, endedAt: r.endTime ?? null, running: workRowRuns(r) })),
  }
}

function kindClockOf(spans: readonly CrewSpan[], words: readonly [string, string], nowMs: number): KindClock | null {
  if (spans.length === 0) return null
  const running = spans.filter(s => s.running)
  const counted = running.length > 0 ? running : spans
  const from = Math.min(...counted.map(s => s.startedAt))
  const to = running.length > 0 ? nowMs : Math.max(...counted.map(s => s.endedAt ?? s.startedAt))
  return { word: counted.length === 1 ? words[0] : words[1], running: running.length > 0, ms: Math.max(0, to - from) }
}

export function crewActiveIn(rows: readonly WorkRowV1[]): boolean {
  const spans = crewSpansOf(rows)
  return spans.agents.some(s => s.running) || spans.workflows.some(s => s.running)
}

export function crewClockOf(rows: readonly WorkRowV1[], nowMs: number): CrewClockV1 {
  const spans = crewSpansOf(rows)
  const kinds = [kindClockOf(spans.agents, ['agent', 'agents'], nowMs), kindClockOf(spans.workflows, ['workflow', 'workflows'], nowMs)].filter(
    (k): k is KindClock => k !== null,
  )
  kinds.sort((a, b) => b.ms - a.ms)
  return {
    active: kinds.some(k => k.running),
    line: kinds.length === 0 ? null : kinds.map(k => `${k.word} thought for ${statusDuration(k.ms)}`).join(' · '),
  }
}

export function statusLine(live: SessionLiveV1, s: SeatStatusV1, crew: CrewClockV1 | null = null): string {
  if (s.hardStopping) return 'stopping — the runner is cut if the turn is still open in a second'
  if (s.interrupting) return 'interrupting — the request is torn down'
  if (live.inFlight) {
    if (s.wait !== null) {
      const waited = s.quietMs !== null && s.quietMs >= 10_000 ? ` · ${statusDuration(s.quietMs)} so far` : ''
      const late = s.wait.kind === 'first-byte' && s.quietMs !== null && s.quietMs > s.wait.budgetMs ? ' — the budget is up; the lane reissues or aborts now' : ''
      return `${requestWaitLine(s.wait)}${waited}${late}`
    }
    if (live.phase === 'waiting') {
      return (live.waitingOn !== undefined ? workWaitingWords(live.waitingOn) : null) ?? crewWaitingWords(live.agentsWaiting) ?? 'waiting on agents'
    }
    if (s.stuck && s.quietMs !== null && s.watchdogMs !== null) {
      return `no stream events for ${statusDuration(s.quietMs)} — the session may be stuck (the watchdog aborts at ${statusDuration(s.watchdogMs)})`
    }
  }
  if (crew !== null && crew.line !== null) return crew.line
  return live.inFlight ? '' : 'ready'
}

export function escBackHint(live: SessionLiveV1, s: Pick<SeatStatusV1, 'interrupting' | 'hardStopping'>): string {
  const hint = escRungHint(escRungOf({ inFlight: live.inFlight, interrupting: s.interrupting, hardStopping: s.hardStopping }))
  return `${hint !== '' ? `${hint} · ` : ''}${keyHintLabel('⇧← back')}`
}

export function fitStatusLine(line: string, columns: number, fixedWidth: number): string {
  const budget = Math.max(12, columns - fixedWidth)
  if (stringWidth(line) <= budget) return line
  return line.includes(' — ') ? truncateKeepingTail(line, budget) : line
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
  return `${getFocusedSeatIdentityKey()}|${s.interrupting ? 1 : 0}|${s.hardStopping ? 1 : 0}|${live.inFlight ? 1 : 0}|${s.stuck ? 1 : 0}|${s.wait?.kind ?? ''}|${statusLine(live, s)}`
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
  const { columns } = useTerminalSize()
  useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatStatusKey, getFocusedSeatStatusKey)
  const live = useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatLive, getFocusedSeatLive)
  const workRows = useFocusedWorkRows()
  const crewActive = crewActiveIn(workRows)
  const now = useNowTick(crewActive ? 1000 : null)
  const crew = useMemo(() => crewClockOf(workRows, now), [workRows, now])
  const c = getFocusedSessionConnector()
  if (!hasSeatLive(c)) return null
  const status: SeatStatusV1 = c.status()
  const line = statusLine(live, status, crew)
  const worktree = status.isolation === 'worktree-isolated' && status.branchLabel !== undefined ? status.branchLabel : null
  const backHint = escBackHint(live, status)
  const fixedWidth =
    1 +
    stringWidth(status.projectLabel) +
    (line !== '' ? 3 : 0) +
    (worktree !== null ? stringWidth(` · ${GLYPH.branch} ${worktree}`) : 0) +
    2 +
    stringWidth(backHint)
  const fitted = fitStatusLine(line, columns, fixedWidth)
  return (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      {
}
      <Text wrap="truncate-end">
        <Text color={t.textMuted}> {status.projectLabel}</Text>
        {fitted !== '' ? (
          <Text>
            <Text color={t.textMuted}> · </Text>
            <Text color={t.textInstruction}>{fitted}</Text>
          </Text>
        ) : null}
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
              {backHint}{' '}
            </Text>
          )}
        </InteractiveRow>
      </Box>
    </Box>
  )
}
