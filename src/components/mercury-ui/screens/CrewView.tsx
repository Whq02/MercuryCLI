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
  crewTokensLabel,
  type CrewAgentFacts,
} from '../../../services/engine-connector/crewFacts.js'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
} from '../../../services/engine-connector/focusedConnector.js'
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
import { TeammateChatsView } from './TeammateChatsView.js'

// ============================================================================
//  CrewView — the session's crew (/teammates): its sub-agents LIVE — the
//  dispatched agents and the named agents its runner hosts — one row each,
//  name · model · status · tokens · elapsed, beside the named agents the
//  daemon keeps for this repo. Every sub-agent row is the ONE record
//  (crewFacts over the focused session's work roster, the same rows the
//  cockpit's CREW lane and the /tasks board paint); the view derives no
//  copy of its own. ↵ on a sub-agent opens its work card (the /tasks
//  board's own card — the agent's stream and controls live with the
//  runner); ↵ on a named agent opens its chat; n spawns a named agent.
//  The rows follow the roster's own cadence (the runner republishes as its
//  agents move); the named glance rides the shared telemetry bus.
// ============================================================================

type Row =
  | { kind: 'agent'; id: string; facts: CrewAgentFacts }
  | { kind: 'named'; id: string; member: CrewGlanceMember }

type Mode =
  | { view: 'list' }
  | { view: 'card'; id: string }
  | { view: 'chat'; name?: string; spawn?: boolean; fromDoor: boolean }

const EMPTY_NAMED: readonly CrewGlanceMember[] = []

/** Column widths — the row reads as a table at 100 columns and truncates
 *  as one line below that (the tail sheds first). */
const NAME_W = 20
const MODEL_W = 18
const STATUS_W = 9
const TOKENS_W = 13

export function CrewView({
  onClose,
  initialChat,
  initialSpawn = false,
}: {
  onClose: () => void
  /** Open straight on this named agent's chat (`/teammates <name>`). */
  initialChat?: string
  /** Open straight in the spawn wizard. */
  initialSpawn?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows: termRows } = useTerminalSize()
  const now = useNowTick(1000)
  const roster = useFocusedWorkRoster()
  const sessionId = focusedSessionIdOrNull()
  // Presence rides the roster's cadence: one cheap read per roster change.
  const presence = useMemo(() => focusedRunnerPresence(), [roster])
  const agents = useMemo(() => crewAgentsOf(roster.rows, sessionId), [roster, sessionId])
  const workById = useMemo(() => new Map(roster.rows.map(r => [r.id, r] as const)), [roster])
  const named = useTelemetry(s => s.crew) ?? EMPTY_NAMED
  const namedOn = crewEnabled()
  // A spend column only where the session is billed per call — a
  // subscription session's dollar figure would read as a fabricated charge.
  const billed = hasFocusedSession() && getFocusedSessionConnector().identity().consoleBilling
  const rows = useMemo<Row[]>(
    () => [
      ...agents.map((facts): Row => ({ kind: 'agent', id: `a:${facts.id}`, facts })),
      ...named.map((member): Row => ({ kind: 'named', id: `n:${member.name}`, member })),
    ],
    [agents, named],
  )
  // Identity-stable cursor: the rows move as agents land and named agents
  // spawn — the selected row follows its id, never a stale position.
  const cursor = useStableSelection(rows, r => r.id)
  const sel = cursor.index
  const [mode, setMode] = useState<Mode>(() =>
    initialChat !== undefined
      ? { view: 'chat', name: initialChat, fromDoor: true }
      : initialSpawn
        ? { view: 'chat', spawn: true, fromDoor: false }
        : { view: 'list' },
  )
  const pastMount = useOpenEventGate()
  // A card whose row the runner evicted falls back to the list.
  const listMode = mode.view === 'list' || (mode.view === 'card' && !workById.has(mode.id))

  // A fresh named glance on entry and on every return from a chat (a spawn
  // or a stop landed there meanwhile).
  useEffect(() => {
    if (listMode) pokeTelemetry()
  }, [listMode])

  useInput((input, key) => {
    // The chat board and the card own their keys.
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
      // The ↵ that opened this view never opens a row (the idle-keypress class).
      if (!pastMount()) return
      const row = rows[sel]
      if (row === undefined) return
      if (row.kind === 'agent') setMode({ view: 'card', id: row.facts.id })
      else setMode({ view: 'chat', name: row.member.name, fromDoor: false })
      return
    }
    if (input === 'n' && namedOn) setMode({ view: 'chat', spawn: true, fromDoor: false })
  })

  if (mode.view === 'chat') {
    // The named agents' board — a door-opened chat closes the whole view on
    // esc (the rail meant the chat); a list-opened one returns to the list.
    return (
      <TeammateChatsView
        onClose={mode.fromDoor ? onClose : () => setMode({ view: 'list' })}
        {...(mode.name !== undefined ? { initialName: mode.name } : {})}
        {...(mode.spawn === true ? { initialSpawn: true } : {})}
      />
    )
  }

  if (mode.view === 'card' && !listMode) {
    const work = workById.get(mode.id)!
    const facts = agents.find(a => a.id === mode.id)
    const back = (): void => setMode({ view: 'list' })
    return (
      <CommandCenter view={`crew › ${facts?.name ?? work.name}`} onClose={back} footer="esc back" captureInput={false}>
        <Box marginTop={1} flexDirection="column">
          <RosterWorkDetail work={work} now={now} onBack={back} />
        </Box>
      </CommandCenter>
    )
  }

  // ── the list ──────────────────────────────────────────────────────────────
  const width = Math.max(56, Math.min((columns || 80) - 6, 120))
  const visible = Math.max(4, (termRows || 24) - 12)
  const win = paneWindow(rows.length, sel, visible)
  const firstNamedIx = rows.findIndex(r => r.kind === 'named')
  const footer = [
    '↑↓ move',
    rows.length > 0 ? '↵ open' : undefined,
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
      </Box>
    </CommandCenter>
  )
}

/** One sub-agent row — every cell from the ONE record's own spellings. */
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
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={on ? tokens.textPrimary : tokens.textMuted}>{on ? `${GLYPH.cursor} ` : '  '}</Text>
        {facts.running && !pending ? <WorkingGlyph color={tokens.success} active /> : <Text color={tone}>{glyph}</Text>}
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
        </Text>
      </Text>
    </Box>
  )
}

/** One named agent — the daemon's glance: liveness, model, unread. */
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
