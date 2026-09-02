// WorkflowDetailDialog — the /workflows task-detail PROGRESS-TREE view.
//
// Opening /workflows lists background tasks; selecting a local_workflow task
// opens this read-only detail panel: a warm-ink progress tree
// of phases → agents, reconstructed from the task's coalesced progress journal.
//
// DATA (primary-sourced from tasks/LocalWorkflowTask/LocalWorkflowTask.tsx):
//   LocalWorkflowTaskState
//     status        'pending'|'running'|'completed'|'failed'|'killed'|'paused'
//     workflowName? / summary / description / title?
//     phases?       WorkflowPhase[]  { title; detail?; model? }
//     defaultModel?
//     workflowProgress  WorkflowProgressEvent[]  (coalesced last-write-wins)
//     agentCount / totalTokens / totalToolCalls
//     logs[] / startTime / endTime? / error?
//   WorkflowProgressEvent
//     workflow_phase { index; title; kind? }
//     workflow_agent { index; label; state 'start'|'progress'|'done'|'error';
//                      phaseIndex?; phaseTitle?; tokens?; toolCalls?;
//                      durationMs?; error?; cached? }
//     workflow_log   { message }
//
// The view is built ONLY on the existing mercury-ui primitives (Panel,
// StateBadge, SectionHeader, EmptyState) + the theme/glyph/accent kit. Zero new
// hex; no emoji. Honest empty / pending states. esc/enter/space + ← back match
// the sibling host detail dialogs (DreamDetailDialog).

import * as React from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type {
  LocalWorkflowTaskState,
  WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  formatQuietAge,
  workflowPulse,
} from '../../tools/WorkflowTool/livePulse.js'
import {
  buildAgentSummaries,
  groupAgentsByPhase,
  type WorkflowPhaseEventLite,
} from '../../tools/WorkflowTool/runManifest.js'
import { formatDuration } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Panel, StateBadge, EmptyState } from '../mercury-ui/components.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import {
  FAINT,
  IVORY,
  SECOND,
  TEAL,
  AMBER,
  CRIMSON,
} from '../mercuryPalette.js'
import { STATE_STYLE, type SnapshotState } from '../mercury-ui/theme.js'

type WorkflowTask = DeepImmutable<LocalWorkflowTaskState>

type Props = {
  workflow: WorkflowTask
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}

// Cap visible agents per phase so a long fan-out never blows the panel height;
// the overflow collapses to a faint count (mirrors DreamDetailDialog's turns).
const MAX_AGENTS_PER_PHASE = 12

// A single agent line, reconstructed from the coalesced workflow_agent events.
// Exported; grouping itself now lives in
// the ONE shared projector (runManifest.groupAgentsByPhase — the task-#3
// rebuild retired the old groupByPhase/toAgentNode adapter in RunDetailPane).
export type AgentNode = {
  index: number
  label: string
  /** 'stopped' = parent settled mid-flight; 'skipped' = operator skip. */
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  tokens?: number
  toolCalls?: number
  durationMs?: number
  error?: string
  cached?: boolean
}

// A phase group: a phase header (from workflow_phase OR the planned phases[])
// plus the agents that reported under it. Exported alongside AgentNode — see
// the note above.
export type PhaseGroup = {
  index: number
  title: string
  detail?: string
  model?: string
  // True when the phase comes only from the planned phases[] structure and has
  // not yet emitted a workflow_phase event — render it as "planned" (honest).
  planned: boolean
  agents: AgentNode[]
}

// workflow_agent.state → the honest 8-state taxonomy (StateBadge):
//   done → live (filled, complete) · error → failed · start/progress → gated
//   (in-flight; the amber "active but not settled" tone) · stopped → off
//   (the parent settled it — muted, no motion, never a fault) · skipped →
//   excluded (deliberately out). Exported — the /workflows board's agent-row
//   list (RunDetailPane), its phase overview (WorkflowsBoard) and the agent
//   inspector (AgentInspectorPane) all reuse this exact taxonomy mapping.
export function agentSnapshotState(state: AgentNode['state']): SnapshotState {
  switch (state) {
    case 'done':
      return 'live'
    case 'error':
      return 'failed'
    case 'stopped':
      return 'off'
    case 'skipped':
      return 'excluded'
    case 'progress':
    case 'start':
    default:
      return 'gated'
  }
}

// The human label for an agent's lifecycle state (overrides the taxonomy word so
// the tree reads in workflow terms, not substrate terms).
function agentStateLabel(state: AgentNode['state']): string {
  switch (state) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'stopped':
      return 'stopped'
    case 'skipped':
      return 'skipped'
    case 'progress':
      return 'running'
    case 'start':
    default:
      return 'queued'
  }
}

// Workflow status → a fixed status-spine tone (NEVER the identity accent — the
// spine is never themed). Mirrors BackgroundTask.tsx's done/running mapping.
// Exported — the /workflows board (WorkflowsBoard/RunDetailPane) reuses this
// for both live (AppState) and disk-sourced (manifest) rows; the manifest's
// `status` union is a subset of WorkflowTask['status'], so it type-checks as-is.
export function statusTone(status: WorkflowTask['status'] | 'completed_with_failures'): {
  color: string
  word: string
} {
  switch (status) {
    case 'completed':
      return { color: TEAL, word: 'done' }
    // a run whose script returned while SOME agents failed is
    // partial, never plain 'done' — the false-success class on unattended runs.
    case 'completed_with_failures':
      return { color: AMBER, word: 'partial' }
    case 'running':
      return { color: TEAL, word: 'running' }
    case 'pending':
      return { color: AMBER, word: 'pending' }
    case 'paused':
      return { color: AMBER, word: 'paused' }
    case 'failed':
      return { color: CRIMSON, word: 'failed' }
    case 'killed':
      return { color: CRIMSON, word: 'killed' }
    default:
      return { color: FAINT, word: status }
  }
}

// Reconstruct the phase→agent tree from the coalesced progress journal via the
// ONE shared projector (runManifest.groupAgentsByPhase — planned-seeded +
// title-merging, so a planned phase and its live twin can never render as
// duplicates; see that function's header for the 0/1-base history). Pure: no
// side effects, never throws on a sparse/empty journal. Exported — the
// /workflows run view and board share it for LIVE runs; a disk-sourced (Past)
// run goes through groupByPhase (same projector, manifest-shaped input).
export function buildTree(workflow: WorkflowTask): PhaseGroup[] {
  const events = (workflow.workflowProgress ??
    []) as readonly WorkflowProgressEvent[]
  const phaseEvents: WorkflowPhaseEventLite[] = []
  for (const ev of events) {
    if (ev.type === 'workflow_phase') {
      phaseEvents.push({ index: ev.index, title: ev.title || `Phase ${ev.index + 1}` })
    }
  }
  // The task layer already coalesced workflow_agent events last-write-wins by
  // index (updateWorkflowProgressBatch), so the summaries carry one row per
  // agent — this is a projection, not a second reducer.
  const agents = buildAgentSummaries(events)
  return groupAgentsByPhase(workflow.phases, phaseEvents, agents).map(g => ({
    index: g.index,
    title: g.title,
    detail: g.detail,
    model: g.model,
    planned: g.planned,
    agents: g.agents.map(s => ({
      index: s.index,
      label: s.label,
      state: s.state,
      tokens: s.tokens,
      toolCalls: s.toolCalls,
      durationMs: s.durationMs,
      error: s.error,
      cached: s.cached,
    })),
  }))
}

// FAINT metrics tail for one agent: tokens · tools · duration. Omitted entirely
// when nothing has been reported (honest — no fabricated zeros while queued).
function AgentMetrics({ agent }: { agent: AgentNode }): React.ReactNode {
  const parts: string[] = []
  if (typeof agent.tokens === 'number' && agent.tokens > 0)
    parts.push(`${agent.tokens.toLocaleString()} tok`)
  if (typeof agent.toolCalls === 'number' && agent.toolCalls > 0)
    parts.push(`${agent.toolCalls} ${plural(agent.toolCalls, 'tool')}`)
  if (typeof agent.durationMs === 'number' && agent.durationMs > 0)
    parts.push(formatDuration(agent.durationMs))
  if (agent.cached) parts.push('cached')
  if (parts.length === 0) return null
  return <Text color={FAINT}> · {parts.join(' · ')}</Text>
}

// One agent row: the taxonomy glyph + label + state word + metrics tail. The
// tree is drawn with a faint └─ connector so phases read as parents. Exported —
// reused verbatim by RunDetailPane's 'i' expand-all tree (deliberately
// a SEPARATE, non-NavigablePanes render path, since PaneRow is a fixed-height
// contract that can't render a variable-height phase/agent card).
export function AgentLine({
  agent,
  last,
}: {
  agent: AgentNode
  last: boolean
}): React.ReactNode {
  const tState = agentSnapshotState(agent.state)
  const s = STATE_STYLE[tState]
  const connector = last ? '└─' : '├─'
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={FAINT}>{`  ${connector} `}</Text>
        <Text color={s.color}>{s.glyph} </Text>
        <Text color={agent.state === 'done' ? IVORY : SECOND}>
          {agent.label}
        </Text>
        <Text color={FAINT}> · </Text>
        <Text color={s.color}>{agentStateLabel(agent.state)}</Text>
        <AgentMetrics agent={agent} />
      </Text>
      {agent.state === 'error' && agent.error ? (
        <Text color={CRIMSON}>{`     ${agent.error}`}</Text>
      ) : null}
    </Box>
  )
}

// One phase group: a phase header (◆ index · title · model) + its agent lines,
// or an honest planned/empty note. Exported — see AgentLine's note above.
export function PhaseBlock({
  group,
  number,
}: {
  group: PhaseGroup
  number: number
}): React.ReactNode {
  const shown = group.agents.slice(0, MAX_AGENTS_PER_PHASE)
  const hiddenAgents = group.agents.slice(MAX_AGENTS_PER_PHASE)
  const hidden = hiddenAgents.length
  // State-aware overflow: a hidden ERROR must never
  // fold silently — errored agents are named by index in CRIMSON; a done count
  // keeps the fold honest about what it hides.
  const hiddenErrs = hiddenAgents.filter(a => a.state === 'error')
  const hiddenDone = hiddenAgents.filter(a => a.state === 'done').length
  // A phase is "settled" when every agent is done (no error, no in-flight).
  const settled =
    group.agents.length > 0 &&
    group.agents.every(a => a.state === 'done')
  const errored = group.agents.some(a => a.state === 'error')
  const headColor = group.planned
    ? SECOND
    : errored
      ? CRIMSON
      : settled
        ? TEAL
        : AMBER
  const headGlyph = group.planned
    ? STATE_STYLE.planned.glyph
    : GLYPH.mission
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={headColor}>{headGlyph} </Text>
        <Text color={FAINT}>{`${number}. `}</Text>
        <Text bold color={group.planned ? SECOND : IVORY}>
          {group.title}
        </Text>
        {group.model ? <Text color={FAINT}>{`  ${group.model}`}</Text> : null}
        {group.planned ? <Text color={SECOND}> · planned</Text> : null}
      </Text>
      {group.detail ? (
        <Text color={FAINT}>{`     ${group.detail}`}</Text>
      ) : null}
      {group.agents.length === 0 && !group.planned ? (
        <Text color={FAINT}>{'  └─ waiting for agents…'}</Text>
      ) : null}
      {shown.map((a, i) => (
        <AgentLine
          key={a.index}
          agent={a}
          last={i === shown.length - 1 && hidden <= 0}
        />
      ))}
      {hidden > 0 ? (
        <Text>
          <Text color={FAINT}>{`  └─ (+${hidden} more ${plural(hidden, 'agent')}`}</Text>
          {hiddenDone > 0 ? <Text color={FAINT}>{` · ${hiddenDone} done`}</Text> : null}
          {hiddenErrs.length > 0 ? (
            <Text color={CRIMSON}>{` · ${GLYPH.fail} ${hiddenErrs.map(a => `#${a.index}`).join(' ')} ${plural(hiddenErrs.length, 'error')}`}</Text>
          ) : null}
          <Text color={FAINT}>{')'}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onBack,
  onKill,
}: Props): React.ReactNode {
  const accent = useSessionAccent().accent
  const isRunning =
    workflow.status === 'running' || workflow.status === 'pending'
  const elapsed = useElapsedTime(
    workflow.startTime,
    isRunning,
    1000,
    0,
    workflow.endTime,
  )

  // Dialog-grade key handling, matched to the sibling host detail dialogs:
  // Esc/Enter/Space → close, ← → back, x → stop (running only).
  useKeybindings(
    { 'confirm:yes': onDone, 'confirm:no': onDone },
    { context: 'Confirmation' },
  )
  const handleKeyDown = (e: KeyboardEvent) => {
    // Esc explicitly (round-3 PTY probe: the Byline advertised Esc while only
    // Enter/Space closed — the ShellDetailDialog dead-esc class again).
    if (e.key === 'escape') {
      e.preventDefault()
      onDone()
    } else if (e.key === ' ') {
      e.preventDefault()
      onDone()
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && isRunning && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  const tree = buildTree(workflow)
  const tone = statusTone(workflow.status)
  const name =
    workflow.workflowName ??
    workflow.title ??
    workflow.summary ??
    workflow.description ??
    'Dynamic workflow'

  // The honest taxonomy state for the header badge.
  const headerState: SnapshotState =
    workflow.status === 'completed'
      ? 'live'
      : workflow.status === 'failed' || workflow.status === 'killed'
        ? 'failed'
        : workflow.status === 'running'
          ? 'gated'
          : 'off'

  // Roll-up metrics line (faint chrome under the title).
  const metrics: string[] = []
  metrics.push(`${tree.length} ${plural(tree.length, 'phase')}`)
  metrics.push(`${workflow.agentCount} ${plural(workflow.agentCount, 'agent')}`)
  if (workflow.totalTokens > 0)
    metrics.push(`${workflow.totalTokens.toLocaleString()} tok`)
  if (workflow.totalToolCalls > 0)
    metrics.push(
      `${workflow.totalToolCalls} ${plural(workflow.totalToolCalls, 'tool')}`,
    )
  if (workflow.defaultModel) metrics.push(workflow.defaultModel)

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {/* a detail dialog is structure — the Panel's neutral rail;
          identity accent stays on the workflow NAME below. */}
      <Panel title="Workflow">
        <Box flexDirection="column">
          {/* Title + honest state badge */}
          <Text>
            <Text bold color={accent}>
              {name}
            </Text>
            <Text> </Text>
            <StateBadge state={headerState} label={tone.word} />
          </Text>

          {/* Faint chrome: phases · agents · tokens · tools · model · elapsed —
              the clock last, subordinate to the counts (the agent rows keep
              the same order). */}
          <Text color={FAINT}>
            {metrics.join(' · ')} · {elapsed}
          </Text>

          {/* The "is it stuck?" probe row (AVS friction: the
              operator killed a healthy run and trusted a dead one). One
              glance: moving-vs-quiet + last agent signal age + live agent /
              attempt counts, from the shared pulse projector every liveness
              surface reads. Quiet is an AMBER look-cue, never a death verdict
              — agent turns legitimately run minutes; the stall watchdog owns
              real deaths. Fresh via the dialog's own 1s elapsed tick. */}
          {isRunning
            ? (() => {
                const pulse = workflowPulse(
                  workflow.workflowProgress ?? [],
                  workflow.startTime,
                  Date.now(),
                )
                return (
                  <Text>
                    {pulse.moving ? (
                      <>
                        <Text color={TEAL}>{GLYPH.inProgress} moving</Text>
                        <Text color={FAINT}>
                          {' '}— last agent signal {formatQuietAge(pulse.quietMs)} ago
                        </Text>
                      </>
                    ) : (
                      <>
                        <Text color={AMBER}>
                          {GLYPH.inProgress} quiet {formatQuietAge(pulse.quietMs)}
                        </Text>
                        <Text color={FAINT}>
                          {' '}— no agent signal; long turns are normal, x stops it
                        </Text>
                      </>
                    )}
                    <Text color={FAINT}>
                      {pulse.running > 0 ? ` · ${pulse.running} running` : ''}
                      {pulse.maxAttempt > 1 ? ` (attempt ${pulse.maxAttempt})` : ''}
                    </Text>
                  </Text>
                )
              })()
            : null}

          {/* The progress tree */}
          {tree.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState
                title={
                  isRunning ? 'Starting…' : 'No phases reported'
                }
                hint={
                  isRunning
                    ? 'agents will appear here as the workflow fans out'
                    : undefined
                }
                glyph={GLYPH.pending}
                tone={isRunning ? 'gated' : 'idle'}
              />
            </Box>
          ) : (
            tree.map((g, i) => (
              <PhaseBlock key={g.index} group={g} number={i + 1} />
            ))
          )}

          {/* Terminal error (failed/killed) */}
          {workflow.error ? (
            <Box marginTop={1}>
              <Text color={CRIMSON}>
                {GLYPH.fail} {workflow.error}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Panel>

      {/* Footer keys — matches the host detail dialogs' Byline */}
      <Box paddingX={1}>
        <Byline>
          {onBack ? (
            <KeyboardShortcutHint shortcut={'←'} action="go back" />
          ) : null}
          <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
          {isRunning && onKill ? (
            <KeyboardShortcutHint shortcut="x" action="stop" />
          ) : null}
        </Byline>
      </Box>
    </Box>
  )
}
