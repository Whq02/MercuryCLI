// AgentInspectorPane — the /workflows AGENT view (board → run → agent),
// rebuilt as the full dossier.
//
// The old pane hid the transcript behind an extra 'i' press and dumped
// unbounded sections below the fold. Now it loads the transcript on ENTRY
// (useAgentTranscriptView — the same throttled live-read hook the run view's
// dossier card uses, so a running agent's activity streams in at the shared
// 2s cadence), leads with the agent's MACHINE MARK (agentHeadAt(index) — the
// ✧ hue chip + persona name the run view's lanes wear; the multi-line face
// art was removed — it sheared on line-spaced terminals), and
// lays the content as
// height-BOUNDED structured sections that always fit the frame:
//   ◇ in — the dispatch prompt        (what the agent was asked)
//   ⟡ activity — its tool calls       (what it did, live while running)
//   ◐ reasoning — its thinking spans  (taller terminals only)
//   ● out — the returned result       (what came back) + the usage line
// Honesty rules: nothing is fabricated — a missing transcript file, unreadable
// reasoning spans, and a not-yet-finished result each say so in plain words.

import * as React from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import { Box, Text, useInput } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getWorkflowTranscriptDir } from '../../utils/sessionStorage.js'
import { plural } from '../../utils/stringUtils.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { agentTranscriptFile } from '../../tools/WorkflowTool/agentTranscriptReader.js'
import {
  buildAgentSummaries,
  type WorkflowRunAgentSummary,
  type WorkflowRunManifest,
} from '../../tools/WorkflowTool/runManifest.js'
import { formatTokens } from '../../utils/format.js'
import { agentHeadAt } from '../../utils/cockpit/agentHeadData.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND } from '../mercuryPalette.js'
import { Crab, Wordmark } from '../mercury-ui/assets.js'
import { displayWidth, GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { STATE_STYLE } from '../mercury-ui/theme.js'
import { agentSnapshotState } from './WorkflowDetailDialog.js'
import { agentPulse, agentPulseWord } from '../../tools/WorkflowTool/livePulse.js'
import { agentRuntime } from './RunDetailPane.js'
import { useNowTick } from '../mercury-ui/components.js'
import { useAgentTranscriptView } from './useAgentTranscriptView.js'

function shortModel(m: string | undefined): string | undefined {
  return m?.replace(/^claude-/, '')
}

function stateWord(state: WorkflowRunAgentSummary['state']): string {
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
    default:
      return 'queued'
  }
}

/** A section heading: state-toned glyph + bold label + faint tail, closed by
 *  a hairline rule to the pane edge (structure law level 3: the four
 *  regions — in · activity · reasoning · out — are individually scannable;
 *  the rule is the PhaseSeparator grammar, semantic structure not
 *  decoration). */
function SectionHead({
  glyph,
  color,
  label,
  tail,
  width,
}: {
  glyph: string
  color: string
  label: string
  tail?: string
  width: number
}): React.ReactNode {
  const used = displayWidth(`${glyph} ${label}${tail ? ` — ${tail}` : ''} `)
  const rule = Math.max(0, width - used)
  return (
    <Box height={1} overflow="hidden" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={color}>{glyph} </Text>
        <Text bold color={IVORY}>
          {label}
        </Text>
        {tail ? <Text color={FAINT}> — {tail}</Text> : null}
        {rule > 0 ? <Text color={FAINT}>{` ${'─'.repeat(rule)}`}</Text> : null}
      </Text>
    </Box>
  )
}

export type AgentInspectorPaneProps = {
  runId: string
  task?: DeepImmutable<LocalWorkflowTaskState>
  manifest?: WorkflowRunManifest & { mtimeMs: number }
  agentIndex: number
  onBack: () => void
}

export function AgentInspectorPane({
  runId,
  task,
  manifest,
  agentIndex,
  onBack,
}: AgentInspectorPaneProps): React.ReactNode {
  // an inspector card is structure — borderSubtle, the NavigablePanes
  // detail-card precedent; identity lives in the Crab+Wordmark lockup.
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const isLive = !!task
  // Clock honesty: the tick PARKS and every runtime
  // freezes at the run's last known instant unless the run is genuinely
  // running — a 'progress' row inside a dead run must never count up.
  const runLive = task?.status === 'running'
  const now = useNowTick(runLive ? 1000 : null)
  const clockNow = runLive
    ? now
    : (task?.endTime ?? manifest?.endTime ?? manifest?.mtimeMs ?? now)
  const summaries: WorkflowRunAgentSummary[] = isLive
    ? buildAgentSummaries(task.workflowProgress)
    : (manifest?.agents ?? [])
  const summary = summaries.find(a => a.index === agentIndex)

  const transcriptDir = manifest?.transcriptDir ?? getWorkflowTranscriptDir(runId)
  const agentId = summary?.agentId
  const read = useAgentTranscriptView({
    transcriptDir,
    fallbackDirs: manifest?.transcriptDirs,
    agentId,
    enabled: !!summary,
    liveState: summary?.state,
    version: isLive ? task?.progressVersion : manifest?.mtimeMs,
  })

  // structure law: long content expands through an EXPLICIT control —
  // `e` grows the prompt/out/reasoning ceilings when something is clipped
  //
  const [expanded, setExpanded] = React.useState(false)
  const expandArmedRef = React.useRef(false)

  useInput((input, key) => {
    if (key.escape || key.leftArrow) {
      onBack()
      return
    }
    if (input === 'e' && expandArmedRef.current) setExpanded(v => !v)
  })

  if (!summary) {
    return (
      <AlternateScreen>
        <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} width="100%">
          <Box>
            <Crab />
            <Text> </Text>
            <Wordmark />
            <Text color={FAINT}> — agent</Text>
          </Box>
          <Text color={FAINT}>agent #{agentIndex} has not reported in this run yet</Text>
          <Box marginTop={1}>
            <Text color={FAINT}>esc / ← back</Text>
          </Box>
        </Box>
      </AlternateScreen>
    )
  }

  const s = STATE_STYLE[agentSnapshotState(summary.state)]
  const head = agentHeadAt(summary.index)
  const view = read.view
  const model = shortModel(summary.model) ?? shortModel(view?.model)
  const innerWidth = Math.max(20, columns - 4)

  // ── bounded section heights — the whole pane must fit the frame ───────────
  // Fixed rows, counted honestly (a SectionHead is TWO rows — its marginTop +
  // the line; the 80×24 render-verify caught the undercount pushing the out
  // section + footer below the fold): border 2 · brand 1 · header card 3
  // · three heads 6
  // (+2 reasoning) · usage 2 · footer 1 ⇒ 15-17, +1 slack for the
  // missing-transcript note row.
  const showReasoning = rows >= 32
  const budget = Math.max(4, rows - (showReasoning ? 19 : 17))
  // CEILINGS per section — on tall terminals these grow generously; the
  // EXPANDED mode (the `e` control) re-shares the budget toward prompt/out
  // with tripled caps so a clipped dispatch prompt or result reads in full
  // where the frame allows (activity keeps a floor; nothing overflows).
  const promptH = expanded
    ? Math.min(24, Math.max(2, Math.floor(budget * 0.3)))
    : Math.min(8, Math.max(2, Math.floor(budget * 0.22)))
  const outH = expanded
    ? Math.min(30, Math.max(2, Math.floor(budget * 0.45)))
    : Math.min(10, Math.max(2, Math.floor(budget * 0.28)))
  const reasoningH = showReasoning
    ? expanded
      ? Math.min(16, Math.max(2, Math.floor(budget * 0.15)))
      : Math.min(8, Math.max(2, Math.floor(budget * 0.2)))
    : 0
  const activityH = Math.max(2, budget - promptH - outH - reasoningH)
  // …but each box SHRINKS to its content (operator screenshot: a
  // ~90-row terminal gave activity ~50 rows while the transcript held 16
  // calls — a void mid-card). Unused rows fall to the bottom spacer instead.
  // −8 margin: wrap breaks at word boundaries, so pure display-width division
  // undercounts by a line or two on long prose — better a
  // slightly taller box than a silently clipped tail.
  const contentWidth = Math.max(16, innerWidth - 8)
  const estLines = (s: string | undefined, cap: number): number => {
    if (!s) return 1
    let lines = 0
    for (const seg of s.split('\n'))
      lines += Math.max(1, Math.ceil(displayWidth(seg) / contentWidth))
    return Math.max(1, Math.min(cap, lines))
  }

  // "x this attempt of y total": the transcript counts THIS attempt's calls,
  // the frame's toolCalls carries the cross-attempt cumulative — a second
  // number only when a retry makes them genuinely differ.
  const attemptCalls = view?.toolCallsTotal
  const totalCalls = summary.toolCalls
  const headMeta: string[] = []
  if (model) headMeta.push(summary.effort ? `${model} @${summary.effort}` : model)
  if (typeof summary.tokens === 'number' && summary.tokens > 0)
    headMeta.push(`${GLYPH.tokens} ${formatTokens(summary.tokens)}`)
  if (
    typeof attemptCalls === 'number' &&
    typeof totalCalls === 'number' &&
    attemptCalls !== totalCalls
  )
    headMeta.push(`${attemptCalls} of ${totalCalls} tool ${plural(totalCalls, 'call')} this attempt`)
  else if (typeof totalCalls === 'number' && totalCalls > 0)
    headMeta.push(`${totalCalls} ${plural(totalCalls, 'tool')}`)
  const runtime = agentRuntime(summary, clockNow)
  if (runtime) headMeta.push(runtime)
  // The ONE pulse derivation: a provider wait or a quiet spell is
  // named in the head instead of hiding behind a generic running state.
  const pulse = agentPulse(summary, clockNow)
  if (pulse.kind === 'backoff' || pulse.kind === 'first-token' || pulse.kind === 'quiet')
    headMeta.push(agentPulseWord(pulse))
  if (typeof summary.attempt === 'number' && summary.attempt > 1)
    headMeta.push(`attempt ${summary.attempt}`)
  if (read.meta?.agentType) headMeta.push(read.meta.agentType)
  if (read.meta?.worktreePath) headMeta.push('worktree')
  if (summary.cached) headMeta.push('cached')

  const calls = view?.toolCalls ?? []
  const shownCalls = calls.slice(-activityH)
  const liveNow = summary.state === 'progress' || summary.state === 'start'

  // Is anything clipped at the CURRENT ceilings? Arms the `e` control and its
  // footer hint together (one predicate — hint and key can never disagree).
  const promptFull = view?.prompt ?? summary.promptPreview
  const outFull = view?.finalText ?? summary.resultPreview ?? summary.error
  const anyClipped =
    estLines(promptFull, promptH + 1) > promptH ||
    estLines(outFull ?? undefined, outH + 1) > outH ||
    view?.promptTruncated === true ||
    view?.finalTextTruncated === true ||
    (view ? shownCalls.length < view.toolCallsTotal : false)
  expandArmedRef.current = anyClipped || expanded

  const usageBits: string[] = []
  if (view?.usage) {
    usageBits.push(
      `${formatTokens(view.usage.inputTokens)} in / ${formatTokens(view.usage.outputTokens)} out ${GLYPH.tokens}`,
    )
    usageBits.push(`${view.usage.apiTurns} api ${plural(view.usage.apiTurns, 'turn')}`)
  }
  if (view?.truncatedRead) usageBits.push('large transcript — head+tail window')

  return (
    <AlternateScreen>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.borderSubtle}
        paddingX={1}
        width="100%"
        flexShrink={0}
        minHeight={Math.max(0, rows - 1)}
      >
        {/* brand */}
        <Box flexShrink={0}>
          <Crab />
          <Text> </Text>
          <Wordmark />
          <Text color={FAINT}> — agent</Text>
        </Box>

        {/* header card: the agent's mark (single-line ✧ hue chip + persona
            name — the half-block face art sheared into detached bars on
            line-spaced terminals and was removed, operator fix)
            + who/what/state */}
        <Box flexShrink={0} marginTop={1}>
          <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="center">
            <Box height={1} overflow="hidden">
              <Text wrap="truncate-end">
                <Text color={head.hue}>{`${GLYPH.sparkFaint} `}</Text>
                <Text color={s.color}>{s.glyph} </Text>
                <Text bold color={IVORY}>
                  {summary.label}
                </Text>
                <Text color={head.hue}>{` · ${head.name}`}</Text>
                <Text color={s.color}>{` · ${stateWord(summary.state)}`}</Text>
              </Text>
            </Box>
            {headMeta.length > 0 ? (
              <Box height={1} overflow="hidden">
                <Text color={FAINT} wrap="truncate-end">
                  {headMeta.join(' · ')}
                </Text>
              </Box>
            ) : null}
            {summary.error ? (
              <Box height={1} overflow="hidden">
                {/* Crimson is the FAULT tone — a skipped/stopped agent's
                    reason line ('skipped by user') settles faint instead. */}
                <Text
                  color={summary.state === 'error' ? CRIMSON : FAINT}
                  wrap="truncate-end"
                >
                  {summary.error}
                </Text>
              </Box>
            ) : null}
          </Box>
        </Box>

        {read.status === 'missing' && agentId ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={AMBER} wrap="truncate-end">
              transcript not on disk yet — {agentTranscriptFile(transcriptDir, agentId)}
            </Text>
          </Box>
        ) : null}
        {!agentId ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={FAINT}>no transcript id yet — the summary above is live</Text>
          </Box>
        ) : null}

        {/* ◇ in */}
        <SectionHead
          glyph={GLYPH.diamond}
          color={SECOND}
          label="in"
          tail={view?.promptTruncated ? 'the dispatch prompt (clipped)' : 'the dispatch prompt'}
          width={innerWidth}
        />
        <Box
          height={estLines(view?.prompt ?? summary.promptPreview, promptH)}
          overflow="hidden"
          flexShrink={0}
        >
          <Text wrap="wrap">
            <Text color={SECOND}>
              {view?.prompt ?? summary.promptPreview ?? (read.status === 'loading' ? 'loading…' : '— not captured —')}
            </Text>
          </Text>
        </Box>

        {/* ⟡ activity */}
        <SectionHead
          glyph={GLYPH.trace}
          color={liveNow ? AMBER : SECOND}
          label="activity"
          tail={
            view
              ? `${
                  // A head+tail read's counts are WINDOW counts, not totals
                  // the '+' marks them as lower bounds.
                  shownCalls.length < view.toolCallsTotal
                    ? `last ${shownCalls.length} of ${view.toolCallsTotal}${view.truncatedRead ? '+' : ''} tool calls`
                    : `${view.toolCallsTotal}${view.truncatedRead ? '+' : ''} tool ${plural(view.toolCallsTotal, 'call')}`
                }${liveNow ? ' · live' : ''}`
              : liveNow
                ? 'live'
                : undefined
          }
          width={innerWidth}
        />
        <Box
          flexDirection="column"
          height={Math.max(1, Math.min(activityH, shownCalls.length || 1))}
          overflow="hidden"
          flexShrink={0}
        >
          {shownCalls.length === 0 ? (
            <Text color={FAINT}>
              {read.status === 'loading' ? 'loading…' : '— no tool calls yet —'}
            </Text>
          ) : (
            shownCalls.map((c, i) => (
              <Box key={i} height={1} overflow="hidden">
                <Text wrap="truncate-end">
                  <Text color={c.isError ? CRIMSON : IVORY}>{c.name}</Text>
                  <Text color={FAINT}>({c.inputSummary})</Text>
                  {c.resultPreview ? (
                    <Text color={c.isError ? CRIMSON : FAINT}> → {c.resultPreview}</Text>
                  ) : null}
                </Text>
              </Box>
            ))
          )}
        </Box>

        {/* ◐ reasoning — taller terminals only */}
        {showReasoning ? (
          <>
            <SectionHead
              glyph={GLYPH.inProgress}
              color={SECOND}
              label="reasoning"
              tail={
                view && view.reasoningTotal > 0
                  ? `${view.reasoningTotal} ${plural(view.reasoningTotal, 'span')}`
                  : view && view.unreadableReasoningTotal > 0
                    ? `${view.unreadableReasoningTotal} ${plural(view.unreadableReasoningTotal, 'span')} (text not persisted)`
                    : undefined
              }
              width={innerWidth}
            />
            <Box
              height={estLines(
                view && view.reasoning.length > 0
                  ? view.reasoning[view.reasoning.length - 1]
                  : '—',
                reasoningH,
              )}
              overflow="hidden"
              flexShrink={0}
            >
              <Text wrap="wrap">
                <Text color={SECOND}>
                  {view && view.reasoning.length > 0
                    ? view.reasoning[view.reasoning.length - 1]
                    : view && view.unreadableReasoningTotal > 0
                      ? '— thinking happened; its text was not persisted —'
                      : '— no reasoning captured —'}
                </Text>
              </Text>
            </Box>
          </>
        ) : null}

        {/* ● out */}
        <SectionHead
          glyph={GLYPH.ok}
          color={s.color}
          label="out"
          tail={view?.finalTextTruncated ? 'the returned result (clipped)' : 'the returned result'}
          width={innerWidth}
        />
        <Box
          height={estLines(
            view?.finalText ?? summary.resultPreview ?? summary.error ?? '—',
            outH,
          )}
          overflow="hidden"
          flexShrink={0}
        >
          <Text wrap="wrap">
            <Text color={summary.state === 'error' ? CRIMSON : IVORY}>
              {view?.finalText ??
                summary.resultPreview ??
                (summary.state === 'error'
                  ? (summary.error ?? 'errored')
                  : liveNow
                    ? '— still working —'
                    : '— no output captured —')}
            </Text>
          </Text>
        </Box>

        {usageBits.length > 0 ? (
          <Box height={1} overflow="hidden" flexShrink={0} marginTop={1}>
            <Text color={FAINT} wrap="truncate-end">
              {usageBits.join(' · ')}
            </Text>
          </Box>
        ) : null}

        {/* spacer + footer */}
        <Box flexGrow={1} />
        <Box flexShrink={0} height={1} overflow="hidden">
          <Text color={FAINT} wrap="truncate-end">
            {truncateToWidth(
              expanded
                ? 'e compact · esc / ← back to the run'
                : anyClipped
                  ? 'e expand · esc / ← back to the run'
                  : 'esc / ← back to the run',
              Math.max(10, innerWidth),
            )}
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  )
}
