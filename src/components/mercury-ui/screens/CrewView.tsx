import * as React from 'react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, wrapText } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import {
  CREW_EMPTY_DOOR,
  CREW_EMPTY_LINE,
  CREW_MODEL_UNKNOWN,
  crewCostLabel,
  crewCountLabel,
  crewElapsedLabel,
  crewModelLabel,
  crewOperatorPauseParts,
  crewPauseChipWords,
  crewSettled,
  crewStatusWords,
  crewWaitLine,
  crewTokensSummary,
  crewUnreadLabel,
  type CrewAgentFacts,
  crewWaitHolders,
} from '../../../services/engine-connector/crewFacts.js'
import { operatorPauseGate } from '../../../run-core/pauseGate.js'
import { WORK_UNREPORTED_LINE, workUnreported } from '../../../services/engine-connector/workCounts.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
} from '../../../services/engine-connector/focusedConnector.js'
import { RosterWorkDetail } from '../../tasks/BackgroundTasksDialog.js'
import {
  focusedRunnerPresence,
  useFocusedWorkRoster,
} from '../../tasks/useFocusedWork.js'
import { Chip, CommandCenter, SectionHeader, useNowTick } from '../components.js'
import { GLYPH, padTo, truncateToWidth } from '../glyphs.js'
import { WorkingGlyph } from '../LiveGlyphs.js'
import { decodeNavKey } from '../navSemantics.js'
import { fitMeasuredWindow, paneWindow } from '../paneWindow.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { useStableSelection } from '../useStableSelection.js'
import { CREW_RESUME_HINT, crewStopArmed, crewStopHint, pressCrewStop, type CrewStopArm } from './crewStopChord.js'
import { crewPauseDoorKey, crewPauseDoorNote, pressCrewPause } from './crewPauseDoor.js'
import { useAppStateMaybeOutsideOfProvider, useSetAppStateMaybe, type AppState } from '../../../state/AppState.js'
import { enterCrewmateView, setMainChat } from '../../../state/crewmateViewHelpers.js'
import { CREW_CLEAR_KEY, CREW_MAIN_CHAT_KEY, CREW_OPEN_IN_VIEW_KEY, crewClearedWords, crewClearRefusedWords } from '../../../utils/cockpit/crewmateWords.js'
import { clearCrewmate } from '../../../state/crewLedger.js'
import { useSessionCrew } from '../../tasks/useCrewLedger.js'
import { crewWorktreeLeftWords } from '../../../utils/crew/crewWorktreeReminder.js'
import { getCwd } from '../../../utils/cwd.js'
import { pauseStatusWords } from '../../../tasks/LocalAgentTask/agentPause.js'


type Row = { kind: 'agent'; id: string; facts: CrewAgentFacts }

type Mode =
  | { view: 'list' }
  | { view: 'card'; id: string }

const OPEN_GATE = { paused: false, parked: 0 } as const

const NAME_W = 20
const MODEL_W = 18
const STATUS_W = 34
function crewRowWidths(width: number, status: string): { name: number; status: number } {
  return { name: width >= 94 && width < 110 ? 12 : NAME_W, status: Math.min(STATUS_W, Math.max(8, status.length)) }
}

export function CrewView({
  onClose,
  popup = false,
}: {
  onClose: () => void
  popup?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows: termRows } = useTerminalSize()
  const now = useNowTick(1000)
  const roster = useFocusedWorkRoster()
  const setAppState = useSetAppStateMaybe()
  const mainChatTaskId = useAppStateMaybeOutsideOfProvider((s: AppState) => s.mainChatTaskId)
  const presence = useMemo(() => focusedRunnerPresence(), [roster])
  const sessionCrew = useSessionCrew()
  const agents = useMemo(() => sessionCrew.map(row => row.facts), [sessionCrew])
  const workById = useMemo(() => new Map(roster.rows.map(r => [r.id, r] as const)), [roster])
  const billed = hasFocusedSession() && getFocusedSessionConnector().identity().consoleBilling
  const rows = useMemo<Row[]>(
    () => agents.map((facts): Row => ({ kind: 'agent', id: `a:${facts.id}`, facts })),
    [agents],
  )
  const crewmates = useMemo(() => rows.map(row => row.facts), [rows])
  const cursor = useStableSelection(rows, r => r.id)
  const sel = cursor.index
  const [mode, setMode] = useState<Mode>(() => ({ view: 'list' }))
  const pastMount = useOpenEventGate()
  const listMode = mode.view === 'list' || (mode.view === 'card' && !workById.has(mode.id))
  const [stopArm, setStopArm] = useState<CrewStopArm | null>(null)
  const [doorNote, setDoorNote] = useState<{ tone: 'muted' | 'warning'; text: string } | null>(null)
  const armedTarget = stopArm !== null && crewStopArmed(stopArm, stopArm.id, now) ? (agents.find(a => a.id === stopArm.id) ?? null) : null
  const gateState = useSyncExternalStore(operatorPauseGate.subscribe, operatorPauseGate.state, operatorPauseGate.state)
  const carrier = getFocusedSessionConnector().carrier
  const hostedGate = roster.pauseGate ?? OPEN_GATE
  const pauseChip = crewPauseChipWords(agents, carrier === 'in-process' ? gateState : hostedGate)
  const pauseDoor = crewPauseDoorKey(pauseChip !== null)

  useInput((input, key) => {
    const selected = rows[sel]
    const target: CrewAgentFacts | null =
      mode.view === 'card' && !listMode
        ? (agents.find(a => a.id === mode.id) ?? null)
        : selected?.kind === 'agent'
          ? selected.facts
          : null
    if (input === 'x' && target !== null && target.running) {
      const press = pressCrewStop(stopArm, target.id, Date.now())
      if (!press.fire) {
        setStopArm(press.arm)
        return
      }
      setStopArm(null)
      setDoorNote(null)
      void getFocusedSessionConnector()
        .stopAgent(target.id)
        .then(receipt => {
          if (receipt.outcome === 'refused') setDoorNote({ tone: 'warning', text: `the stop of ${target.name} was refused: ${receipt.detail ?? 'no reason given'}` })
        })
      return
    }
    if (input === 'p') {
      setStopArm(null)
      const reach = hasFocusedSession()
        ? { kind: 'carrier' as const, carrier: getFocusedSessionConnector().carrier, hostedPaused: hostedGate.paused, send: (paused: boolean) => getFocusedSessionConnector().pauseGate(paused) }
        : { kind: 'blank' as const }
      void pressCrewPause(reach, operatorPauseGate).then(receipt => setDoorNote(crewPauseDoorNote(receipt)))
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && target !== null && setAppState !== null) {
      setStopArm(null)
      if (!crewSettled(target)) {
        setDoorNote({ tone: 'muted', text: crewClearRefusedWords(target) })
        return
      }
      const cleared = clearCrewmate(target.id, setAppState)
      setDoorNote(cleared ? { tone: 'muted', text: crewClearedWords(target.name) } : { tone: 'warning', text: crewClearRefusedWords(target) })
      return
    }
    if (input === 'r' && target !== null && !target.running) {
      setDoorNote({ tone: 'muted', text: `resuming ${target.name} from its transcript…` })
      void getFocusedSessionConnector()
        .resumeAgent(target.id)
        .then(receipt => {
          setDoorNote(
            receipt.outcome === 'applied'
              ? { tone: 'muted', text: `${target.name} resumed from its transcript — it runs on under the same id` }
              : { tone: 'warning', text: `the resume of ${target.name} was refused: ${receipt.detail ?? 'no reason given'}` },
          )
        })
      return
    }
    if (!listMode) return
    const nav = decodeNavKey(input, key, { orientation: 'vertical' })
    if (nav === 'cancel') {
      onClose()
      return
    }
    if (nav === 'movePrevious') {
      cursor.select(sel - 1)
      return
    }
    if (nav === 'moveNext') {
      cursor.select(sel + 1)
      return
    }
    if (nav === 'activate') {
      if (!pastMount()) return
      const row = rows[sel]
      if (row === undefined) return
      if (!popup || setAppState === null) {
        setMode({ view: 'card', id: row.facts.id })
        return
      }
      enterCrewmateView(row.facts.id, setAppState)
      onClose()
      return
    }
    if (input === 'm' && selected?.kind === 'agent' && setAppState !== null) {
      if (!pastMount()) return
      setMainChat(selected.facts.id, setAppState)
      enterCrewmateView(selected.facts.id, setAppState)
      onClose()
      return
    }
  })

  const doorKeys = (target: CrewAgentFacts | null): string[] =>
    armedTarget !== null ? [crewStopHint(armedTarget.name)] : [...(target === null ? [] : target.running ? ['x x stop'] : crewSettled(target) ? ['r resume', CREW_CLEAR_KEY] : ['r resume']), pauseDoor]

  if (mode.view === 'card' && !listMode) {
    const work = workById.get(mode.id)!
    const facts = agents.find(a => a.id === mode.id)
    const back = (): void => setMode({ view: 'list' })
    const cardFooter = [...doorKeys(facts ?? null), 'esc back'].join(' · ')
    return (
      <CommandCenter elevated view={`crew › ${facts?.name ?? work.name}`} onClose={back} footer={cardFooter} captureInput={false}>
        <Box marginTop={1} flexDirection="column">
          <RosterWorkDetail work={work} now={now} onBack={back} />
          {doorNote !== null ? <Text color={doorNote.tone === 'warning' ? tokens.warning : tokens.textMuted} wrap="truncate-middle">· {doorNote.text}</Text> : null}
        </Box>
      </CommandCenter>
    )
  }

  const width = popup ? Math.max(0, Math.min(columns, 120)) : Math.max(56, (columns || 80) - 6)
  const visible = Math.max(4, (termRows || 24) - 9)
  const win = fitMeasuredWindow(rows.length, visible, span => paneWindow(rows.length, sel, span), window =>
    rows.slice(window.start, window.end).reduce((height, row) => height + 1 + (row.facts.state === 'paused' ? wrapText(crewStatusWords(row.facts, now), Math.max(1, width - 4), 'wrap').split('\n').length : 0), 0),
  )
  const selectedRow = rows[sel]
  const footer = (armedTarget !== null
    ? [crewStopHint(armedTarget.name), 'esc close']
    : [
        '↑↓ move',
        rows.length > 0 ? (popup ? CREW_OPEN_IN_VIEW_KEY : '↵ open') : undefined,
        selectedRow?.kind === 'agent' ? (mainChatTaskId === selectedRow.facts.id ? `${CREW_MAIN_CHAT_KEY} (this one)` : CREW_MAIN_CHAT_KEY) : undefined,
        ...doorKeys(selectedRow?.kind === 'agent' ? selectedRow.facts : null),
        'esc close',
      ])
    .filter(Boolean)
    .join(' · ')

  return (
    <CommandCenter elevated view="crew" subtitle={crewCountLabel(crewmates)} onClose={onClose} footer={footer} captureInput={false}>
      <Box marginTop={1} flexDirection="column">
        {presence === 'blank' ? (
          <Text color={tokens.textMuted}>no chat is focused — a session's crewmates list here</Text>
        ) : null}
        {presence === 'dormant' ? (
          <Text color={tokens.textMuted}>the session has no live runner — ↵ in the chat revives it</Text>
        ) : null}
        {pauseChip !== null ? (
          <Text>
            <Chip tone="warn">{pauseChip}</Chip>
          </Text>
        ) : null}
        <SectionHeader marginTop={0} count={rows.length}>
          Crewmates
        </SectionHeader>
        {rows.length === 0 ? (
          <Text color={tokens.textMuted}>
            {workUnreported(roster) ? `· ${WORK_UNREPORTED_LINE}` : `· ${CREW_EMPTY_LINE} — ${CREW_EMPTY_DOOR}`}
          </Text>
        ) : null}
        {win.above > 0 ? <Text color={tokens.textMuted}>  ↑ {win.above} earlier</Text> : null}
        {rows.slice(win.start, win.end).map((row, wi) => {
          const gi = win.start + wi
          const on = gi === sel
          return (
            <React.Fragment key={row.id}>
              <AgentRow facts={row.facts} on={on} now={now} width={width} billed={billed} />
            </React.Fragment>
          )
        })}
        {win.below > 0 ? <Text color={tokens.textMuted}>  ↓ {win.below} later</Text> : null}
        {doorNote !== null ? <Text color={doorNote.tone === 'warning' ? tokens.warning : tokens.textMuted} wrap="truncate-middle">· {doorNote.text}</Text> : null}
      </Box>
    </CommandCenter>
  )
}

function AgentRow({
  facts,
  on,
  now,
  width,
  billed,
}: {
  facts: CrewAgentFacts
  on: boolean
  now: number
  width: number
  billed: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const failed = facts.state === 'failed'
  const stopped = facts.state === 'stopped' || facts.state === 'interrupted'
  const paused = facts.state === 'paused'
  const pending = facts.status === 'pending'
  const settled = crewSettled(facts)
  const tone = facts.running ? tokens.success : failed ? tokens.failure : stopped || paused ? tokens.warning : tokens.textMuted
  const glyph = failed || stopped ? GLYPH.fail : pending || paused ? GLYPH.pending : facts.running ? GLYPH.busy : GLYPH.done
  const nameColor = on ? tokens.textPrimary : settled ? tokens.textMuted : tokens.textSecondary
  const spend = billed ? crewCostLabel(facts) : null
  const wait = crewWaitLine(facts)
  const holders = crewWaitHolders(facts)
  const unread = crewUnreadLabel(facts)
  const parkedByOperator = crewOperatorPauseParts(facts)
  const status = crewStatusWords(facts, now)
  const cells = crewRowWidths(width, status)
  return (
    <Box width={width} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={on ? tokens.textPrimary : tokens.textMuted}>{on ? `${GLYPH.cursor} ` : '  '}</Text>
        {facts.running && !pending && wait === null ? <WorkingGlyph color={tokens.success} active /> : <Text color={wait !== null ? tokens.warning : tone}>{wait !== null ? GLYPH.pending : glyph}</Text>}
        <Text bold={on} color={nameColor}>
          {' '}
          {padTo(truncateToWidth(facts.name, cells.name), cells.name)}
        </Text>
        <Text color={settled ? tokens.textMuted : tokens.textSecondary}> {padTo(truncateToWidth(crewModelLabel(facts), MODEL_W), MODEL_W)}</Text>
        <Text color={tone}> {padTo(truncateToWidth(paused ? 'paused' : status, cells.status), cells.status)}</Text>
        <Text color={tokens.textPrimary}> {crewTokensSummary(facts)}</Text>
        <Text color={tokens.textMuted}>
          {' '}
          {crewElapsedLabel(facts, now)}
          {spend !== null ? ` · ${spend}` : ''}
          {
}
          {stopped || failed ? ` · ${facts.stopReason !== null ? `${facts.stopReason} · ` : ''}${CREW_RESUME_HINT}` : ''}
          {parkedByOperator !== null ? ` · ${parkedByOperator.detail}` : ''}
          {settled && facts.worktree !== null ? ` · ${crewWorktreeLeftWords(facts.worktree)}` : ''}
        </Text>
        {unread !== null ? <Text color={tokens.warning}> · {unread}</Text> : null}
        {holders !== null ? <Text color={tokens.warning}> · {holders}</Text> : null}
      </Text>
      {paused ? <Box paddingLeft={4} width={width}><Text color={tone} wrap="wrap">{status}</Text></Box> : null}
    </Box>
  )
}
