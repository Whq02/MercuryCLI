// resources/adapters/workflow — workflow runs + their agents
// (mercury://workflow/<runId>, agent child via ?child=<agentId>). Reads the
// REAL run manifests (the /workflows board's source of truth).
//
// The guarded field class: monitoring a live run by hand-
// parsing .claude/workflows/runs/<id>/run.json on a schema guessed by trial
// (`status` vs `state`) — a run view carrying no PHASE state, an
// agent child returning RAW JSONL lines. One Inspect answers run /
// phase / liveness / per-agent state from the canonical manifest reader and
// the ONE phase projector (groupAgentsByPhase — the same one /workflows
// renders), and the agent child rides the canonical transcript projection
// (readAgentTranscript) instead of raw lines. No second parser, no run.json.

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { statSync } from 'node:fs'
import { readAgentTranscript, resolveAgentTranscriptFile } from '../../../tools/WorkflowTool/agentTranscriptReader.js'
import { agentPulse, agentPulseWord } from '../../../tools/WorkflowTool/livePulse.js'
import {
  groupAgentsByPhase,
  listWorkflowRunsDetailed,
  readRunManifest,
  runLiveness,
  workflowRunsRoot,
} from '../../../tools/WorkflowTool/runManifest.js'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
import {
  formatRef,
  boundedTextView,
  pageHint,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

export const workflowAdapter: ResourceAdapter = {
  kind: 'workflow',
  describe: 'workflow runs, phases, agents (mercury://workflow/<runId>?child=<agentId>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      // Bounded to what the listing shows + honest partiality
      // (K1a): an I/O-degraded sweep says so instead of presenting the
      // remainder as the whole.
      const { rows: runs, unreadable } = await listWorkflowRunsDetailed(ctx.cwd, { limit: 50 })
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://workflow',
          kind: 'workflow',
          title: 'workflow runs',
          summary: `${runs.length} run(s) under ${workflowRunsRoot(ctx.cwd)}${
            unreadable > 0 ? ` · ${unreadable} unreadable (listing PARTIAL)` : ''
          }`,
          mutable: false,
          children: runs.map(r => ({
            ref: formatRef('workflow', r.runId),
            title: `${r.workflowName ?? r.title ?? r.runId}`,
            summary: `${runLiveness(r, r.mtimeMs, Date.now(), pidAlive)} · ${r.agentCount} agent(s)`,
          })),
        },
      }
    }
    const runDir = path.join(workflowRunsRoot(ctx.cwd), ref.id)
    const manifest = await readRunManifest(runDir)
    if (!manifest) {
      return { state: 'absent', note: `no workflow run '${ref.id}' (no manifest under ${runDir})` }
    }
    // Agent child: the canonical transcript projection (raw lines only when a
    // lines/q/cursor selector explicitly asks for the stream).
    if (ref.selectors.child) {
      const agent = manifest.agents.find(
        a => (a as { agentId?: string }).agentId === ref.selectors.child,
      )
      if (!agent) {
        return {
          state: 'absent',
          note: `run '${ref.id}' has no agent '${ref.selectors.child}' — agents: ${manifest.agents
            .map(a => (a as { agentId?: string }).agentId)
            .join(', ')}`,
        }
      }
      const ag = agent as { state?: string; label?: string }
      // Fallback across every destination the run has written under (
      // Q12): a chain split by /clear or a cross-session resume is found in
      // the manifest's append-only transcriptDirs list.
      const transcriptPath =
        resolveAgentTranscriptFile(
          [manifest.transcriptDir, ...(manifest.transcriptDirs ?? [])],
          String(ref.selectors.child),
        ) ?? null
      const wantsRawStream =
        ref.selectors.lines !== undefined ||
        ref.selectors.q !== undefined ||
        ref.selectors.cursor !== undefined
      let text = '(no transcript recorded)'
      let structured: unknown
      if (transcriptPath && wantsRawStream) {
        try {
          // Tail-by-default + explicit paging: the stream's
          // verdict lives at the end, and the page line lets a reader REACH
          // the rest instead of guessing.
          const view = boundedTextView(readFileSync(transcriptPath, 'utf8'), ref.selectors, 50, {
            defaultToTail: true,
          })
          const shown = view.text ? view.text.split('\n').length : 0
          const hint = pageHint(view.page, shown)
          text = view.text + (hint ? `\n${hint}` : '')
          structured = { page: view.page }
        } catch {
          text = `(transcript unreadable: ${transcriptPath})`
        }
      } else if (transcriptPath) {
        const view = await readAgentTranscript(transcriptPath)
        if (view) {
          const running = ag.state === 'start' || ag.state === 'progress'
          const parts: string[] = []
          if (view.prompt) parts.push(`PROMPT: ${view.prompt.slice(0, 400)}${view.promptTruncated ? '…' : ''}`)
          parts.push(
            `ACTIVITY (${view.toolCallsTotal} call(s), last ${Math.min(view.toolCalls.length, 8)}):`,
            ...view.toolCalls.slice(-8).map(c => `  ${c.name}(${c.inputSummary})${c.isError ? ' [ERROR]' : ''}`),
          )
          if (view.finalText) {
            parts.push(
              running ? 'LATEST TEXT (agent still running — not final):' : 'OUTCOME:',
              view.finalText,
            )
            if (view.finalTextTruncated) parts.push('[outcome truncated at cap]')
          } else {
            parts.push(running ? '(no outcome yet — agent running)' : '(agent produced no final text)')
          }
          if (view.truncatedRead) parts.push('[transcript over the full-read ceiling — head+tail read]')
          text = parts.join('\n')
          structured = {
            state: ag.state,
            hasFinalText: view.finalText !== undefined,
            toolCallsTotal: view.toolCallsTotal,
            model: view.model,
          }
        } else {
          text = `(transcript not readable yet: ${transcriptPath})`
        }
      }
      return {
        state: 'ok',
        resource: {
          ref: `${ref.canonical}?child=${ref.selectors.child}`,
          kind: 'workflow',
          title: `agent ${ref.selectors.child} in ${manifest.workflowName ?? ref.id}`,
          summary: `${ag.state ?? '?'} · ${ag.label ?? ''}`,
          mutable: false,
          text,
          ...(structured !== undefined ? { structured } : {}),
        },
      }
    }
    let manifestMtime = Date.now()
    try {
      manifestMtime = statSync(path.join(runDir, 'run.json')).mtimeMs
    } catch {
      /* liveness falls back to now */
    }
    const liveness = runLiveness(manifest, manifestMtime, Date.now(), pidAlive)
    // ONE Inspect answers run/phase/liveness/agent state — the same projector
    // /workflows renders.
    const phases = groupAgentsByPhase(manifest.phases, [], manifest.agents)
    const stateCounts = (agents: readonly unknown[]): string => {
      const counts = new Map<string, number>()
      for (const a of agents) {
        const s = (a as { state?: string }).state ?? '?'
        counts.set(s, (counts.get(s) ?? 0) + 1)
      }
      return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(' · ')
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'workflow',
        title: manifest.workflowName ?? manifest.title ?? manifest.runId,
        summary: `${liveness} · ${manifest.agentCount} agent(s) · ${manifest.totalTokens} tokens`,
        version: `${manifest.status}-${manifest.agents.length}`,
        mutable: false,
        text: [
          `status: ${manifest.status} (${liveness})`,
          `started: ${new Date(manifest.startTime).toISOString()}`,
          ...(manifest.endTime ? [`ended: ${new Date(manifest.endTime).toISOString()}`] : []),
          ...(manifest.error ? [`error: ${manifest.error}`] : []),
          `phases (${phases.length}):`,
          ...phases.map(p => {
            const label = p.index >= 0 ? `${p.index + 1}. ${p.title}` : p.title
            const body = p.planned
              ? 'planned (no agents yet)'
              : `${p.agents.length} agent(s): ${stateCounts(p.agents)}`
            return `  ${label} — ${body}`
          }),
          `agents (${manifest.agents.length}):`,
          ...manifest.agents.slice(0, 50).map(a => {
            const ag = a as {
              agentId?: string
              label?: string
              state?: string
              phaseTitle?: string
            }
            // The ONE pulse derivation: an in-flight agent's line
            // names a provider wait / prefill / quiet spell instead of
            // presenting a bare running state.
            const pulseBit =
              ag.state === 'progress' || ag.state === 'start'
                ? (() => {
                    const p = agentPulse(a as never, Date.now())
                    return p.kind === 'working' && p.toolLine === undefined
                      ? ''
                      : ` · ${agentPulseWord(p)}`
                  })()
                : ''
            return `  ${ag.agentId} — ${ag.state ?? '?'}${pulseBit}${ag.label ? ` · ${ag.label}` : ''}${ag.phaseTitle ? ` · phase ${ag.phaseTitle}` : ''}`
          }),
          ...(manifest.logsTail?.length ? ['', 'log tail:', ...manifest.logsTail.slice(-10)] : []),
        ].join('\n'),
        children: manifest.agents.slice(0, 50).map(a => {
          const ag = a as { agentId?: string; label?: string; state?: string }
          return {
            ref: `${ref.canonical}?child=${ag.agentId}`,
            title: `agent ${ag.agentId}`,
            summary: `${ag.state ?? '?'}${ag.label ? ` · ${ag.label}` : ''}`,
          }
        }),
        structured: {
          runId: manifest.runId,
          status: manifest.status,
          liveness,
          agents: manifest.agentCount,
          phases: phases.map(p => ({
            title: p.title,
            planned: p.planned,
            agentStates: p.agents.map(a => (a as { state?: string }).state ?? '?'),
          })),
          agentStates: Object.fromEntries(
            manifest.agents
              .slice(0, 50)
              .map(a => {
                const ag = a as { agentId?: string; state?: string }
                return [ag.agentId ?? '?', ag.state ?? '?'] as const
              }),
          ),
        },
      },
    }
  },
}
