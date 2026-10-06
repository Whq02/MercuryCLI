import React, { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { enterConcourse } from '../context/surfaceRoute.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive, IDLE_LIVE, type SeatStatusV1, type SessionLiveV1 } from '../services/engine-connector/seatLive.js'
import type { SampleRowV1, WorkRowV1 } from '../services/engine-connector/types.js'
import { escRungHint, escRungOf } from '../input-core/interruptArity.js'
import { crewAgentsOf, crewWaitingWords } from '../services/engine-connector/crewFacts.js'
import { withSampleWords, workRowRuns, workWaitingWords } from '../services/engine-connector/workCounts.js'
import { requestWaitLine } from '../services/providers/streamIdleBudget.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateKeepingTail } from '../utils/truncate.js'
import { GLYPH, branchChip } from './mercury-ui/glyphs.js'
import { keyHintLabel } from './mercury-ui/keyHintLabel.js'
import { useNowTick } from './mercury-ui/components.js'
import { focusedWorkflowRows, useFocusedSamples, useFocusedWorkRows } from './tasks/useFocusedWork.js'
import { useFocusedShellRunning } from '../services/engine-connector/shellRunning.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../utils/settings/snapshot.js'
import { AttachedAttributionContext } from './messages/TranscriptNameplate.js'
import { useCoordinatorAttribution } from './concourse/workerTranscriptFold.js'
import { useDisplayedSessionModel, useFocusedBornEffort, useFocusedSentEffort, useFocusedServedEffort } from '../hooks/useDisplayedSessionModel.js'
import { useFocusedWorkspaceBranch } from '../hooks/useFocusedWorkspaceBranch.js'
import { useCrewmateModel } from './tasks/useCrewmateModel.js'
import { renderModelChip } from '../utils/model/model.js'
import { focusedEffortLabelOf } from './mercury-ui/EffortChip.js'
import { modelSupportsEffort } from '../utils/effort.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { crewmateLive, useComposerCrewmate, useViewedCrewmate } from './tasks/useCrewmateView.js'
import { crewmateStatusRightHint, crewmateStatusWords } from '../utils/cockpit/crewmateWords.js'


const subscribeFocusedSeat = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
function getFocusedSeatLive(): SessionLiveV1 {
  const c = getFocusedSessionConnector()
  return hasSeatLive(c) ? c.live() : IDLE_LIVE
}
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective

export const STATUS_ROW_RECEIPT_MS = 8000

let receiptText: string | null = null
let receiptTimer: ReturnType<typeof setTimeout> | null = null
let rowsPainting = 0
const receiptListeners = new Set<() => void>()

function emitReceipt(): void {
  for (const listener of receiptListeners) listener()
}

export function paintStatusRowReceipt(text: string): boolean {
  if (rowsPainting === 0 || text.trim() === '') return false
  if (receiptTimer !== null) clearTimeout(receiptTimer)
  receiptText = text
  receiptTimer = setTimeout(() => {
    receiptTimer = null
    receiptText = null
    emitReceipt()
  }, STATUS_ROW_RECEIPT_MS)
  receiptTimer.unref?.()
  emitReceipt()
  return true
}

export function subscribeStatusRowReceipt(listener: () => void): () => void {
  receiptListeners.add(listener)
  return () => {
    receiptListeners.delete(listener)
  }
}

export function statusRowReceipt(): string {
  return receiptText ?? ''
}

export function modelStatusWords(modelLabel: string, effortLabel: string | null): string {
  const model = modelLabel.trim()
  if (model === '') return ''
  const effort = effortLabel === null ? '' : effortLabel.trim()
  return effort === '' ? model : `${model} · ${effort}`
}

export function restingStatusWords(modelLabel: string, effortLabel: string | null): string {
  const words = modelStatusWords(modelLabel, effortLabel)
  return words === '' ? 'ready' : `ready · ${words}`
}

export const STATUS_ROW_MIN_WORDS = 24
export const STATUS_ROW_WORDS_FLOOR = 12

export type StatusRowPlanV1 = { rest: string; right: string; folderShown: boolean; branchShown: boolean; fixedWidth: number }

export function statusRowPlan(input: {
  columns: number
  head: string
  rest: string
  samples: readonly SampleRowV1[]
  folder: string
  branch: string | null
  backHint: string
}): StatusRowPlanV1 {
  const { columns, head, rest, samples, folder, branch, backHint } = input
  const rightWords = (folderShown: boolean, branchShown: boolean): string => {
    const chip = branchShown && branch !== null ? branchChip(branch) : ''
    const name = folderShown ? folder : ''
    return name !== '' && chip !== '' ? `${name} ${chip}` : name !== '' ? name : chip
  }
  const spoken = withSampleWords(rest, samples)
  const clause = rest.includes(' — ') ? rest.slice(rest.lastIndexOf(' — ')) : ''
  const restFloor = spoken === '' ? 0 : Math.min(stringWidth(spoken), Math.max(STATUS_ROW_MIN_WORDS, stringWidth(clause) + 1))
  const fixed = (right: string): number => 1 + stringWidth(head) + (restFloor > 0 && head !== '' ? 3 : 0) + (right !== '' ? 1 + stringWidth(right) + 1 : 0) + 2 + stringWidth(backHint)
  const shapes: Array<[boolean, boolean]> = [[true, true], [false, true], [false, false]]
  let chosen: [boolean, boolean] = [false, false]
  for (const shape of shapes) {
    if (fixed(rightWords(shape[0], shape[1])) + restFloor <= columns) {
      chosen = shape
      break
    }
  }
  const right = rightWords(chosen[0], chosen[1])
  const fixedWidth = fixed(right)
  const fitted = columns - fixedWidth < STATUS_ROW_WORDS_FLOOR ? '' : fitStatusWords(rest, samples, columns, fixedWidth)
  return { rest: fitted, right, folderShown: chosen[0] && right !== '', branchShown: chosen[1] && branch !== null && right !== '', fixedWidth }
}

export function statusRowWarns(live: SessionLiveV1, s: Pick<SeatStatusV1, 'interrupting' | 'hardStopping' | 'wait' | 'stuck'>): boolean {
  return s.hardStopping || s.interrupting || (live.inFlight && (s.wait !== null || s.stuck))
}
export function statusDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m`
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

export function waitingStatusWords(live: SessionLiveV1): string {
  return (live.waitingOn !== undefined ? workWaitingWords(live.waitingOn) : null) ?? crewWaitingWords(live.agentsWaiting) ?? 'waiting on agents'
}

export function statusLine(live: SessionLiveV1, s: SeatStatusV1, crew: CrewClockV1 | null = null, compact = false): string {
  if (s.hardStopping) return 'interrupting again — the request is torn down once more; x on its row stops the runner'
  if (s.interrupting) return 'interrupting — the request is torn down'
  if (live.inFlight) {
    if (s.wait !== null) {
      if (s.wait.kind === 'silence') return requestWaitLine(s.wait, compact)
      const ownClock = s.wait.kind === 'first-byte' && s.wait.checkedMs !== undefined
      const waited = !ownClock && s.quietMs !== null && s.quietMs >= 10_000 ? ` · ${statusDuration(s.quietMs)} so far` : ''
      const late = s.wait.kind === 'first-byte' && s.wait.promise !== true && s.quietMs !== null && s.quietMs > s.wait.budgetMs ? ' — the budget is up; the lane reissues or aborts now' : ''
      return `${requestWaitLine(s.wait, compact)}${waited}${late}`
    }
    if (live.phase === 'waiting') {
      if (compact) return 'waiting on background work'
      return waitingStatusWords(live)
    }
    if (s.stuck && s.quietMs !== null && s.watchdogMs !== null) {
      return `no stream events for ${statusDuration(s.quietMs)} — the session may be stuck (the watchdog aborts at ${statusDuration(s.watchdogMs)})`
    }
  }
  if (crew !== null && crew.line !== null) return crew.line
  return live.inFlight ? '' : 'ready'
}

export function escBackHint(live: SessionLiveV1, s: Pick<SeatStatusV1, 'interrupting' | 'hardStopping'>, shellRunning = false): string {
  const rung = escRungOf({ inFlight: live.inFlight, interrupting: s.interrupting, hardStopping: s.hardStopping })
  const hint = escRungHint(rung)
  const background = shellRunning && rung === 'in-flight' ? keyHintLabel('⇧b backgrounds') : ''
  return `${hint !== '' ? `${hint} · ` : ''}${background !== '' ? `${background} · ` : ''}${keyHintLabel('⇧← back')}`
}

export function fitStatusLine(line: string, columns: number, fixedWidth: number): string {
  const budget = statusLineBudget(columns, fixedWidth)
  if (stringWidth(line) <= budget) return line
  return line.includes(' — ') ? truncateKeepingTail(line, budget) : line
}

export function statusLineBudget(columns: number, fixedWidth: number): number {
  return Math.max(12, columns - fixedWidth)
}

export function fitStatusWords(line: string, samples: readonly SampleRowV1[], columns: number, fixedWidth: number): string {
  const spoken = withSampleWords(line, samples)
  if (stringWidth(spoken) <= statusLineBudget(columns, fixedWidth)) return spoken
  return fitStatusLine(line, columns, fixedWidth)
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
  const sessionId = hasSeatLive(c) ? c.sessionId() : null
  return <SwitchboardAttributionBridge sessionId={sessionId}>{children}</SwitchboardAttributionBridge>
}

function SwitchboardAttributionBridge({
  sessionId,
  children,
}: {
  sessionId: string | null
  children: React.ReactNode
}): React.ReactNode {
  const classify = useCoordinatorAttribution(sessionId ?? '', null)
  return <AttachedAttributionContext.Provider value={sessionId === null ? null : classify}>{children}</AttachedAttributionContext.Provider>
}

export function FocusedSessionStatusRow(): React.ReactNode {
  const t = useMercuryTokens()
  const { columns } = useTerminalSize()
  useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatStatusKey, getFocusedSeatStatusKey)
  const live = useSyncExternalStore(subscribeFocusedSeat, getFocusedSeatLive, getFocusedSeatLive)
  const workRows = useFocusedWorkRows()
  const samples = useFocusedSamples()
  const shellRunning = useFocusedShellRunning()
  useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)
  const crewActive = crewActiveIn(workRows)
  const now = useNowTick(crewActive ? 1000 : null)
  const crew = useMemo(() => crewClockOf(workRows, now), [workRows, now])
  const modelName = useDisplayedSessionModel().compact
  const effectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel)
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const bornEffort = useFocusedBornEffort()
  const effortValue = useAppStateMaybeOutsideOfProvider(s => s.effortValue)
  const receipt = useSyncExternalStore(subscribeStatusRowReceipt, statusRowReceipt, statusRowReceipt)
  const crewmate = useViewedCrewmate()
  const composerCrewmate = useComposerCrewmate()
  const crewmateModel = useCrewmateModel(crewmate)
  const { folder, branch } = useFocusedWorkspaceBranch()
  const c = getFocusedSessionConnector()
  const painting = hasSeatLive(c)
  useEffect(() => {
    if (!painting) return
    rowsPainting += 1
    return () => {
      rowsPainting -= 1
    }
  }, [painting])
  if (!painting) return null
  const status: SeatStatusV1 = c.status()
  const line = composerCrewmate !== null ? crewmateStatusWords(crewmate, composerCrewmate, composerCrewmate.running) : statusLine(live, status, crew)
  const backHint =
    crewmate !== null && !crewmate.pinned
      ? `${crewmateStatusRightHint(false, crewmateLive(crewmate))} · ${keyHintLabel('⇧← back')}`
      : escBackHint(live, status, shellRunning && getSettingsSnapshot().settings.view?.backgroundKey !== false)
  const effortLabel = modelSupportsEffort(effectiveModel) ? focusedEffortLabelOf(effectiveModel, seatEffort, sentEffort, effortValue, bornEffort, false) : null
  const shownModel = crewmate !== null && crewmateModel !== null ? (crewmateModel.model === null ? 'model unreported' : renderModelChip(crewmateModel.model)) : modelName
  const shownEffort = crewmate !== null && crewmateModel !== null ? crewmateModel.effort : effortLabel
  const modelWords = modelStatusWords(shownModel, shownEffort)
  const held = receipt !== '' && !statusRowWarns(live, status) ? receipt : null
  const resting = held === null && line === 'ready'
  const head = resting ? restingStatusWords(shownModel, shownEffort) : modelWords
  const rest = held ?? (resting ? '' : line)
  const plan = statusRowPlan({ columns, head, rest, samples, folder, branch, backHint })
  const fitted = plan.rest
  return (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      {
}
      <Text wrap="truncate-end">
        {resting ? (
          <Text>
            <Text color={t.textInstruction}> ready</Text>
            <Text color={t.textMuted}>{head.slice('ready'.length)}</Text>
          </Text>
        ) : (
          <Text color={t.textMuted}> {head}</Text>
        )}
        {fitted !== '' ? (
          <Text>
            {head !== '' ? <Text color={t.textMuted}> · </Text> : null}
            <Text color={held !== null || resting ? t.textMuted : t.textInstruction}>{fitted}</Text>
          </Text>
        ) : null}
      </Text>
      <Box flexGrow={1} />
      {plan.right !== '' ? (
        <Box flexShrink={0}>
          <Text>
            {plan.folderShown ? <Text color={t.textMuted}> {folder}</Text> : null}
            {plan.branchShown && branch !== null ? <Text color={t.textSecondary}> {branchChip(branch)}</Text> : null}
            <Text> </Text>
          </Text>
        </Box>
      ) : null}
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
