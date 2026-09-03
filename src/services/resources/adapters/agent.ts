// resources/adapters/agent — background agents/processes from the SESSION's
// task registry (mercury://agent/<taskId>), with the disk output tail as the
// detail view and the CANONICAL transcript projection as the report view
// Needs an AppState
// reader: outside a session context (headless registry probes) it answers
// 'unavailable' honestly.
//
// the task-notification envelope advertises
// `full output: mercury://agent/<agentId>`, but this adapter read ONLY the
// task .output file — for Agent-tool tasks the real stream lives at
// subagents/agent-<agentId>.jsonl, so the advertised ref answered "(output
// not readable)" and the field agent hand-wrote a JSONL parser THREE times to
// get its verification agent's final report. The fix reuses the ONE canonical
// reader (WorkflowTool/agentTranscriptReader.readAgentTranscript — the same
// projection the /workflows inspector renders): `?child=report` returns the
// final report with explicit running/absent/truncated states, and the detail
// view resolves the transcript path properly. No second parser anywhere.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import {
  readAgentTranscript,
  type AgentTranscriptView,
} from '../../../tools/WorkflowTool/agentTranscriptReader.js'
import type { AgentId } from '../../../types/ids.js'
import { getAgentTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { getTaskOutputPath } from '../../../utils/task/diskOutput.js'
import {
  boundedTextView,
  formatRef,
  pageHint,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

/** The detail view's read ceiling: the verdict lives at the END of a stream,
 *  so a long-running agent's multi-megabyte transcript is read from its tail
 *  window only — the answer is bounded by this, never by the file. */
export const AGENT_TAIL_READ_CAP_BYTES = 512 * 1024

/** The last `cap` bytes of a file (the whole file when it fits), with the
 *  size it was cut from — a bounded synchronous read on every platform. */
export function readTailWindow(path: string, cap: number = AGENT_TAIL_READ_CAP_BYTES): { text: string; total: number; cut: boolean } {
  const total = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const length = Math.min(total, cap)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, total - length)
    let text = buffer.toString('utf8')
    if (length < total) {
      // Start at a line boundary: the first partial line is a cut line.
      const newline = text.indexOf('\n')
      if (newline >= 0) text = text.slice(newline + 1)
    }
    return { text, total, cut: length < total }
  } finally {
    closeSync(fd)
  }
}

/** The status word the model reads: the store's own stop word is 'killed';
 *  every crew surface (the rail, the Crew view, the task notification the
 *  runner emits) says 'stopped' — one vocabulary, here too. */
export function agentStatusWord(status: string): string {
  return status === 'killed' ? 'stopped' : status
}

interface TaskRow {
  id: string
  type: string
  status: string
  description: string
  startTime: number
  endTime?: number
  outputFile?: string
}

function tasksFrom(ctx: ResourceContext): TaskRow[] | null {
  if (!ctx.getAppState) return null
  try {
    const state = ctx.getAppState() as { tasks?: Record<string, TaskRow> }
    if (!state || typeof state !== 'object' || !state.tasks) return null
    return Object.values(state.tasks)
  } catch {
    return null
  }
}

/** The content source for an agent/task id, in resolution order: the task's
 *  declared output file, the task disk output, the SUBAGENT transcript (the
 *  real stream for Agent-tool tasks — taskId === agentId there). */
function contentPathFor(id: string, task: TaskRow | undefined): string | null {
  const candidates: string[] = []
  if (task?.outputFile) candidates.push(task.outputFile)
  try {
    candidates.push(getTaskOutputPath(id))
  } catch {
    /* no session storage context */
  }
  try {
    candidates.push(getAgentTranscriptPath(id as AgentId))
  } catch {
    /* no session storage context */
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return null
}

/** Render the report view from the canonical projection — explicit states,
 *  never a silent truncation. */
function reportText(view: AgentTranscriptView, running: boolean): string {
  const lines: string[] = []
  if (view.finalText) {
    lines.push(view.finalText)
    if (view.finalTextTruncated) {
      lines.push('', `[report truncated at cap — full stream behind this ref without ?child=report]`)
    }
    if (running) {
      lines.push('', `[agent still RUNNING — this is the latest text, not a final report]`)
    }
  } else {
    lines.push(
      running
        ? '(no report yet — the agent is still running; latest activity below)'
        : '(the agent produced no final text — activity summary below)',
    )
    const recent = view.toolCalls.slice(-5)
    for (const c of recent) {
      lines.push(`  ${c.name}(${c.inputSummary})${c.isError ? ' [ERROR]' : ''}`)
    }
  }
  if (view.truncatedRead) {
    lines.push('', `[transcript exceeded the full-read ceiling — head+tail windows were read]`)
  }
  return lines.join('\n')
}

export const agentAdapter: ResourceAdapter = {
  kind: 'agent',
  describe:
    'session agents/processes + their output (mercury://agent/<taskId>; final report via ?child=report)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    const tasks = tasksFrom(ctx)
    if (tasks === null) {
      return {
        state: 'unavailable',
        note: 'agent refs need a live session context (no AppState reader here)',
      }
    }
    if (ref.id === '') {
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://agent',
          kind: 'agent',
          title: 'session agents + processes',
          summary: `${tasks.length} task(s) · ${tasks.filter(t => t.status === 'running').length} running`,
          mutable: false,
          children: tasks.slice(0, 50).map(t => ({
            ref: formatRef('agent', t.id),
            title: `${t.id} (${t.type})`,
            summary: `${agentStatusWord(t.status)} · ${t.description.slice(0, 80)}`,
          })),
        },
      }
    }
    const task = tasks.find(t => t.id === ref.id)
    const contentPath = contentPathFor(ref.id, task)

    // ── the final-report selector: the canonical projection ──
    if (ref.selectors.child === 'report') {
      if (!contentPath) {
        return {
          state: 'absent',
          note: task
            ? `agent '${ref.id}' (${task.status}) has produced no output/transcript yet`
            : `no agent/process '${ref.id}' in this session and no transcript on disk`,
        }
      }
      const view = await readAgentTranscript(contentPath)
      if (!view) {
        return { state: 'absent', note: `transcript for '${ref.id}' is unreadable (${contentPath})` }
      }
      const running = task?.status === 'running'
      const status = task ? agentStatusWord(task.status) : 'unregistered (transcript on disk)'
      return {
        state: 'ok',
        resource: {
          ref: `${ref.canonical}?child=report`,
          kind: 'agent',
          title: `${ref.id} — final report`,
          // A head+tail read's counts are window counts —
          // the '+' marks them as lower bounds.
          summary: `${status}${running ? ' · REPORT NOT FINAL' : ''} · ${view.toolCallsTotal}${view.truncatedRead ? '+' : ''} tool call(s) · ${view.entryCount}${view.truncatedRead ? '+' : ''} entries`,
          version: `${status}-${view.entryCount}`,
          mutable: false,
          text: reportText(view, running),
          structured: {
            id: ref.id,
            status,
            running,
            hasFinalText: view.finalText !== undefined,
            finalTextTruncated: view.finalTextTruncated === true,
            truncatedRead: view.truncatedRead === true,
            toolCallsTotal: view.toolCallsTotal,
            model: view.model,
          },
        },
      }
    }

    // Registry miss + no durable record ⇒ genuinely absent. A registry miss
    // WITH a record on disk serves it: the envelope advertises
    // this ref, and the ~30s panel grace must not make the advertised ref
    // answer absent while the durable stream sits readable on disk.
    if (!task && !contentPath) {
      return {
        state: 'absent',
        note: `no agent/process '${ref.id}' in this session and no record on disk`,
      }
    }
    let outputTail = '(no output file)'
    let page: { cursor: number; hasMore: boolean; total: number } | undefined
    if (contentPath) {
      try {
        const window = readTailWindow(contentPath)
        // Tail-by-default: the verdict lives at the END of a
        // transcript stream; an explicit ?cursor pages deterministically
        // within the bounded window (a slow disk or a huge stream never
        // holds the answer past the window's own size).
        const view = boundedTextView(window.text, ref.selectors, 100, {
          defaultToTail: true,
        })
        page = view.page
        const shown = view.text ? view.text.split('\n').length : 0
        const hint = pageHint(view.page, shown)
        const cutNote = window.cut
          ? `\n[tail window: the last ${Math.round(window.text.length / 1024)} KB of ${Math.round(window.total / 1024)} KB — the cursor pages within it]`
          : ''
        outputTail = (view.text || '(empty output)') + (hint ? `\n${hint}` : '') + cutNote
      } catch {
        outputTail = '(output not readable — the task may not have produced any)'
      }
    } else {
      outputTail = '(output not readable — the task may not have produced any)'
    }
    const status = task ? agentStatusWord(task.status) : 'settled (record on disk)'
    const elapsed = task ? (task.endTime ?? Date.now()) - task.startTime : undefined
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'agent',
        title: task ? `${task.id} (${task.type})` : `${ref.id} (agent)`,
        summary: task
          ? `${status} · ${Math.round((elapsed ?? 0) / 1000)}s · ${task.description.slice(0, 100)}`
          : `${status} · transcript on disk`,
        version: task
          ? `${status}-${task.endTime ?? 'live'}`
          : `${status}-${page?.total ?? 0}`,
        mutable: false,
        text: outputTail,
        children: [
          {
            ref: `${ref.canonical}?child=report`,
            title: 'final report',
            summary: 'the agent\'s final text via the canonical transcript projection',
          },
        ],
        structured: {
          id: ref.id,
          type: task?.type ?? 'agent',
          status,
          ...(elapsed !== undefined ? { elapsedMs: elapsed } : {}),
          // The page is part of the contract — a reader must be able to
          // REACH the end, never guess at it.
          ...(page ? { page } : {}),
        },
      },
    }
  },
}
