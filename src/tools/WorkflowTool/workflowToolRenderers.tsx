// Inline transcript renderers for the Workflow tool: the one-line tool-use
// label, and a RESULT line that stays live. The result piece subscribes to the
// task in AppState, so while a run is in flight the transcript itself answers
// "what is it doing and is it stuck?" — current phase, live agent count,
// token total, and a last-event age that turns amber when the run goes quiet.
// Once the task settles, the same line becomes the terminal summary.
//
// Two renderers are intentionally absent:
//   • a tool-use progress renderer — the tool answers with async_launched
//     almost immediately, so the unresolved-tool_use window is effectively
//     zero; the live result line below carries the ongoing story instead;
//   • a rejected-message renderer — the shared "cancelled" fallback is the
//     right reading for a workflow that never launched.

import * as React from 'react'

import { Text } from '../../ink.js'
import { AMBER, CRIMSON, FAINT, TEAL } from '../../components/mercuryPalette.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatQuietAge, workflowPulse } from './livePulse.js'

// Width budget for the one-line preview of a script that failed to compile.
const BROKEN_SCRIPT_PREVIEW_COLS = 80

/** The validated Workflow tool output this module reads. Mirrors the tool's
 *  output schema; fields the renderer does not branch on are kept so the type
 *  stays assignable from the tool's result data. */
export type WorkflowResultContent = {
  status?: 'async_launched'
  taskId?: string
  workflowName?: string
  summary?: string
  runId?: string
  warning?: string
  error?: string
}

/** The narrow parse view the tool-use line needs. Injected by the tool (which
 *  owns the compiler), keeping this module a pure presentation leaf. */
export type ParsedForRender =
  | { ok: true; description: string }
  | { ok: false }

/**
 * The tool-use label line. Render precedence is name > script — deliberately
 * not the tool's resolve precedence (scriptPath > name > script), because a
 * named launch should read as its name even when a script rode along.
 */
export function renderWorkflowToolUseMessage(
  input: { name?: string; script?: string },
  verbose: boolean,
  parse: (script: string) => ParsedForRender,
): React.ReactNode {
  if (input.name) return <Text>dynamic workflow: {input.name}</Text>
  if (!input.script) return null
  if (verbose) return <Text>{input.script}</Text>

  const parsed = parse(input.script)
  if (parsed.ok) return <Text>{parsed.description}</Text>

  // The script failed to parse — show its first non-empty line, clipped, with
  // a line-count tail so the operator knows how much is hidden.
  const scriptLines = input.script.split('\n')
  const headline =
    scriptLines.find(l => l.trim().length > 0) ?? input.script.slice(0, 40)
  const clipped =
    headline.length > BROKEN_SCRIPT_PREVIEW_COLS
      ? `${headline.slice(0, BROKEN_SCRIPT_PREVIEW_COLS - 1)}…`
      : headline
  const tail = scriptLines.length > 1 ? ` · +${scriptLines.length} lines` : ''
  return (
    <Text>
      <Text color={FAINT}>{clipped}</Text>
      {tail ? <Text color={FAINT}>{tail}</Text> : null}
    </Text>
  )
}

/**
 * The live result piece. Isolated as its OWN component so the AppState
 * subscription and the tick interval keep a stable hook lifecycle no matter
 * which branch the calling renderer takes (Rules of Hooks).
 */
export function WorkflowResultLive({ taskId }: { taskId: string }): React.ReactNode {
  const task = useAppState(s => s.tasks[taskId]) as
    | LocalWorkflowTaskState
    | undefined
  // Coarse clock for the last-event age. Ticks only while the run is live —
  // a null interval parks it — and 10s grain is plenty: the age word changes
  // at seconds/minutes granularity, so re-renders stay cheap.
  const live =
    task !== undefined &&
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    task.status !== 'killed' &&
    task.status !== 'paused'
  const nowMs = useNowTick(live ? 10_000 : null)

  if (!task) {
    return (
      <Text>
        <Text color={TEAL}>/workflows</Text>
        <Text color={FAINT}> to view dynamic workflow runs</Text>
      </Text>
    )
  }

  const settled =
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'killed'
  if (task.status === 'paused') {
    // A paused run is not running — say so, and point at the one-key resume.
    return (
      <Text>
        <Text color={AMBER}>{GLYPH.fisheye} </Text>
        <Text>Paused · finished agents stay cached · </Text>
        <Text color={TEAL}>/workflows</Text>
        <Text color={FAINT}> → R resumes it</Text>
      </Text>
    )
  }
  if (!settled) {
    const asks = task.pendingPermissions?.size ?? 0
    // One shared projector derives the pulse for every liveness surface, so
    // the transcript can never disagree with the board or the statusbar.
    const pulse = workflowPulse(task.workflowProgress ?? [], task.startTime, nowMs)
    const clauses: string[] = []
    if (pulse.phaseTitle) clauses.push(pulse.phaseTitle)
    if (pulse.running > 0) clauses.push(`${pulse.running} running`)
    else if (task.agentCount > 0)
      clauses.push(`${task.agentCount} ${plural(task.agentCount, 'agent')}`)
    if (pulse.maxAttempt > 1) clauses.push(`attempt ${pulse.maxAttempt}`)
    if (task.totalTokens > 0)
      clauses.push(`${GLYPH.tokens} ${formatTokens(task.totalTokens)}`)
    return (
      <Text>
        {asks > 0 ? (
          <>
            <Text color={AMBER}>{GLYPH.inProgress} </Text>
            <Text>Waiting on {asks} permission {plural(asks, 'ask')} · </Text>
          </>
        ) : (
          <>
            <Text color={TEAL}>{GLYPH.inProgress} </Text>
            <Text>Running · </Text>
          </>
        )}
        {clauses.length > 0 ? <Text color={FAINT}>{clauses.join(' · ')} · </Text> : null}
        {/* Over two minutes of silence turns the age amber — an inspect cue,
            never a verdict (the runner's stall watchdog owns that call). */}
        <Text color={pulse.moving ? FAINT : AMBER}>
          last event {formatQuietAge(pulse.quietMs)} ago
        </Text>
        <Text color={FAINT}> · </Text>
        <Text color={TEAL}>/tasks {taskId}</Text>
        <Text color={FAINT}> to inspect</Text>
      </Text>
    )
  }

  const word =
    task.status === 'failed'
      ? 'Failed'
      : task.status === 'killed'
        ? 'Stopped'
        : 'Completed'
  const tone = task.status === 'completed' ? TEAL : CRIMSON
  const elapsed =
    task.endTime && task.startTime
      ? formatDuration(task.endTime - task.startTime)
      : undefined
  const clauses: string[] = []
  if (elapsed) clauses.push(`in ${elapsed}`)
  if (task.agentCount > 0)
    clauses.push(`${task.agentCount} ${plural(task.agentCount, 'agent')}`)
  if (task.totalTokens > 0) clauses.push(`${formatTokens(task.totalTokens)} tokens`)
  const tail = clauses.length > 0 ? ` · ${clauses.join(' · ')}` : ''

  return (
    <Text>
      <Text color={tone}>{GLYPH.done} </Text>
      <Text>{word}</Text>
      <Text color={FAINT}>{tail}</Text>
    </Text>
  )
}

/**
 * The tool-result renderer. The error variant (a script that failed its
 * syntax check) renders statically; a launched run delegates to the live
 * subscribed component keyed by its task id.
 */
export function renderWorkflowResultMessage(
  content: WorkflowResultContent,
): React.ReactNode {
  if (content.error) {
    return (
      <Text>
        <Text color={CRIMSON}>{GLYPH.fail} </Text>
        <Text>{content.error}</Text>
      </Text>
    )
  }
  if (content.taskId) return <WorkflowResultLive taskId={content.taskId} />
  return (
    <Text>
      <Text color={TEAL}>/workflows</Text>
      <Text color={FAINT}> to view dynamic workflow runs</Text>
    </Text>
  )
}
