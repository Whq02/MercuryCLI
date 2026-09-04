import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { crewEnabled } from '../../../daemon/crewSpawn.js'
import {
  CREW_EMPTY_DOOR,
  CREW_EMPTY_LINE,
  CREW_MODEL_UNKNOWN,
  crewAgentsOf,
  crewCostLabel,
  crewCountLabel,
  crewElapsedLabel,
  crewModelLabel,
  crewStateLabel,
  crewWaitLine,
  crewTokensLabel,
  type CrewAgentFacts,
} from '../../../services/engine-connector/crewFacts.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
} from '../../../services/engine-connector/focusedConnector.js'
import { spawnSwitchOffReceipt } from '../../../services/switchboard/spawnSwitches.js'
import { pokeTelemetry, useTelemetry, type CrewGlanceMember } from '../../../state/telemetryBus.js'
import { RosterWorkDetail } from '../../tasks/BackgroundTasksDialog.js'
import {
  focusedRunnerPresence,
  focusedSessionIdOrNull,
  useFocusedWorkRoster,
} from '../../tasks/useFocusedWork.js'
import { CommandCenter, SectionHeader, useNowTick } from '../components.js'
import { GLYPH, padTo, truncateToWidth } from '../glyphs.js'
import { WorkingGlyph } from '../LiveGlyphs.js'
import { decodeNavKey } from '../navSemantics.js'
import { paneWindow } from '../paneWindow.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { useStableSelection } from '../useStableSelection.js'
import { CREW_RESUME_HINT, crewStopArmed, crewStopHint, pressCrewStop, type CrewStopArm } from './crewStopChord.js'
import { TeammateChatsView } from './TeammateChatsView.js'


type Row =
  | { kind: 'agent'; id: string; facts: CrewAgentFacts }
  | { kind: 'named'; id: string; member: CrewGlanceMember }

type Mode =
  | { view: 'list' }
  | { view: 'card'; id: string }
  | { view: 'chat'; name?: string; spawn?: boolean; fromDoor: boolean }

const EMPTY_NAMED: readonly CrewGlanceMember[] = []

const NAME_W = 20
const MODEL_W = 18
const STATUS_W = 9
const TOKENS_W = 14

export function CrewView({
  onClose,
  initialChat,
  initialSpawn = false,
}: {
  onClose: () => void
  initialChat?: string
  initialSpawn?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows: termRows } = useTerminalSize()
  const now = useNowTick(1000)
  const roster = useFocusedWorkRoster()
  const sessionId = focusedSessionIdOrNull()
  const presence = useMemo(() => focusedRunnerPresence(), [roster])
  const agents = useMemo(() => crewAgentsOf(roster.rows, sessionId), [roster, sessionId])
  const workById = useMemo(() => new Map(roster.rows.map(r => [r.id, r] as const)), [roster])
  const named = useTelemetry(s => s.crew) ?? EMPTY_NAMED
  const namedOn = crewEnabled()
  const billed = hasFocusedSession() && getFocusedSessionConnector().identity().consoleBilling
  const rows = useMemo<Row[]>(
    () => [
      ...agents.map((facts): Row => ({ kind: 'agent', id: `a:${facts.id}`, facts })),
      ...named.map((member): Row => ({ kind: 'named', id: `n:${member.name}`, member })),
    ],
    [agents, named],
  )
  const cursor = useStableSelection(rows, r => r.id)
  const sel = cursor.index
  const spawnGate = (): string | null =>
    getFocusedSessionConnector().spawnSwitches().subagents.on ? null : spawnSwitchOffReceipt('subagents')
  const [spawnNote, setSpawnNote] = useState<string | null>(() => (initialSpawn ? spawnGate() : null))
  const [mode, setMode] = useState<Mode>(() =>
    initialChat !== undefined
      ? { view: 'chat', name: initialChat, fromDoor: true }
      : initialSpawn && spawnGate() === null
        ? { view: 'chat', spawn: true, fromDoor: false }
        : { view: 'list' },
  )
  const pastMount = useOpenEventGate()
  const listMode = mode.view === 'list' || (mode.view === 'card' && !workById.has(mode.id))
  const [stopArm, setStopArm] = useState<CrewStopArm | null>(null)
  const [doorNote, setDoorNote] = useState<{ tone: 'muted' | 'warning'; text: string } | null>(null)
  const armedTarget = stopArm !== null && crewStopArmed(stopArm, stopArm.id, now) ? (agents.find(a => a.id === stopArm.id) ?? null) : null

  useEffect(() => {
    if (listMode) pokeTelemetry()
  }, [listMode])

  useInput((input, key) => {
    if (mode.view === 'chat') return
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
      if (row.kind === 'agent') setMode({ view: 'card', id: row.facts.id })
      else setMode({ view: 'chat', name: row.member.name, fromDoor: false })
      return
    }
    if (input === 'n' && namedOn) {
      const gate = spawnGate()
      if (gate !== null) {
        setSpawnNote(gate)
        return
      }
      setMode({ view: 'chat', spawn: true, fromDoor: false })
    }
  })

  if (mode.view === 'chat') {
    return (
      <TeammateChatsView
        onClose={mode.fromDoor ? onClose : () => setMode({ view: 'list' })}
        {...(mode.name !== undefined ? { initialName: mode.name } : {})}
        {...(mode.spawn === true ? { initialSpawn: true } : {})}
      />
    )
  }

  const doorKeys = (target: CrewAgentFacts | null): string[] =>
    armedTarget !== null ? [crewStopHint(armedTarget.name)] : target === null ? [] : target.running ? ['x x stop'] : ['r resume']

  if (mode.view === 'card' && !listMode) {
    const work = workById.get(mode.id)!
    const facts = agents.find(a => a.id === mode.id)
    const back = (): void => setMode({ view: 'list' })
    const cardFooter = [...doorKeys(facts ?? null), 'esc back'].join(' · ')
    return (
      <CommandCenter view={`crew › ${facts?.name ?? work.name}`} onClose={back} footer={cardFooter} captureInput={false}>
        <Box marginTop={1} flexDirection="column">
          <RosterWorkDetail work={work} now={now} onBack={back} />
          {doorNote !== null ? <Text color={doorNote.tone === 'warning' ? tokens.warning : tokens.textMuted}>· {doorNote.text}</Text> : null}
        </Box>
      </CommandCenter>
    )
  }

  const width = Math.max(56, Math.min((columns || 80) - 6, 120))
  const visible = Math.max(4, (termRows || 24) - 12)
  const win = paneWindow(rows.length, sel, visible)
  const firstNamedIx = rows.findIndex(r => r.kind === 'named')
  const selectedRow = rows[sel]
  const footer = [
    '↑↓ move',
    rows.length > 0 ? '↵ open' : undefined,
    ...doorKeys(selectedRow?.kind === 'agent' ? selectedRow.facts : null),
    namedOn ? 'n new named agent' : undefined,
    'esc close',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CommandCenter view="crew" subtitle={crewCountLabel(agents)} onClose={onClose} footer={footer} captureInput={false}>
      <Box marginTop={1} flexDirection="column">
        {presence === 'blank' ? (
          <Text color={tokens.textMuted}>no chat is focused — a session's sub-agents list here</Text>
        ) : null}
        {presence === 'dormant' ? (
          <Text color={tokens.textMuted}>the session has no live runner — ↵ in the chat revives it</Text>
        ) : null}
        <SectionHeader marginTop={0} count={agents.length}>
          Sub-agents
        </SectionHeader>
        {agents.length === 0 ? (
          <Text color={tokens.textMuted}>
            · {CREW_EMPTY_LINE} — {CREW_EMPTY_DOOR}
          </Text>
        ) : null}
        {win.above > 0 ? <Text color={tokens.textMuted}>  ↑ {win.above} earlier</Text> : null}
        {rows.slice(win.start, win.end).map((row, wi) => {
          const gi = win.start + wi
          const on = gi === sel
          return (
            <React.Fragment key={row.id}>
              {row.kind === 'named' && gi === firstNamedIx ? (
                <SectionHeader count={named.length}>Named agents</SectionHeader>
              ) : null}
              {row.kind === 'agent' ? (
                <AgentRow facts={row.facts} on={on} now={now} width={width} billed={billed} />
              ) : (
                <NamedRow member={row.member} on={on} width={width} />
              )}
            </React.Fragment>
          )
        })}
        {win.below > 0 ? <Text color={tokens.textMuted}>  ↓ {win.below} later</Text> : null}
        {named.length === 0 ? (
          <>
            <SectionHeader count={0}>Named agents</SectionHeader>
            <Text color={tokens.textMuted}>
              {namedOn
                ? '· no named agents yet — press n to spawn one'
                : '· crew is disabled (MERCURY_CREW=0) — no named agents can spawn'}
            </Text>
          </>
        ) : null}
        {spawnNote !== null ? <Text color={tokens.warning}>· {spawnNote}</Text> : null}
        {doorNote !== null ? <Text color={doorNote.tone === 'warning' ? tokens.warning : tokens.textMuted}>· {doorNote.text}</Text> : null}
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
  const stopped = facts.state === 'stopped'
  const pending = facts.status === 'pending'
  const tone = facts.running ? tokens.success : failed ? tokens.failure : stopped ? tokens.warning : tokens.textMuted
  const glyph = failed || stopped ? GLYPH.fail : pending ? GLYPH.pending : facts.running ? GLYPH.busy : GLYPH.done
  const spend = billed ? crewCostLabel(facts) : null
  const wait = crewWaitLine(facts)
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={on ? tokens.textPrimary : tokens.textMuted}>{on ? `${GLYPH.cursor} ` : '  '}</Text>
        {facts.running && !pending && wait === null ? <WorkingGlyph color={tokens.success} active /> : <Text color={wait !== null ? tokens.warning : tone}>{wait !== null ? GLYPH.pending : glyph}</Text>}
        <Text bold={on} color={on ? tokens.textPrimary : tokens.textSecondary}>
          {' '}
          {padTo(truncateToWidth(facts.name, NAME_W), NAME_W)}
        </Text>
        <Text color={tokens.textSecondary}> {padTo(truncateToWidth(crewModelLabel(facts), MODEL_W), MODEL_W)}</Text>
        <Text color={tone}> {padTo(truncateToWidth(crewStateLabel(facts), STATUS_W), STATUS_W)}</Text>
        <Text color={tokens.textPrimary}> {padTo(crewTokensLabel(facts) ?? CREW_MODEL_UNKNOWN, TOKENS_W)}</Text>
        <Text color={tokens.textMuted}>
          {' '}
          {crewElapsedLabel(facts, now)}
          {spend !== null ? ` · ${spend}` : ''}
          {
}
          {stopped || failed ? ` · ${facts.stopReason !== null ? `${facts.stopReason} · ` : ''}${CREW_RESUME_HINT}` : ''}
        </Text>
        {wait !== null ? <Text color={tokens.warning}> · {wait}</Text> : null}
      </Text>
    </Box>
  )
}

function NamedRow({
  member,
  on,
  width,
}: {
  member: CrewGlanceMember
  on: boolean
  width: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={on ? tokens.textPrimary : tokens.textMuted}>{on ? `${GLYPH.cursor} ` : '  '}</Text>
        <Text color={member.online ? tokens.success : tokens.textMuted}>{member.online ? GLYPH.busy : GLYPH.idle}</Text>
        <Text bold={on} color={on ? tokens.textPrimary : tokens.textSecondary}>
          {' '}
          {padTo(truncateToWidth(`@${member.name}`, NAME_W), NAME_W)}
        </Text>
        <Text color={tokens.textSecondary}> {padTo(truncateToWidth(member.model ?? CREW_MODEL_UNKNOWN, MODEL_W), MODEL_W)}</Text>
        <Text color={member.online ? tokens.success : tokens.textMuted}>
          {' '}
          {padTo(member.online ? 'online' : 'offline', STATUS_W)}
        </Text>
        <Text color={member.unread > 0 ? tokens.warning : tokens.textMuted}>
          {' '}
          {member.unread > 0 ? `${member.unread} new` : 'chat'}
        </Text>
      </Text>
    </Box>
  )
}
