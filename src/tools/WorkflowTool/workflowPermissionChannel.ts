// Permission elicitation for subagents inside a BACKGROUND workflow run.
//
// A workflow detaches from the turn that launched it, but its subagents still
// hit tool calls that resolve to 'ask'. This module wraps the session's real
// canUseTool (captured by WorkflowTool.call() as its third parameter) for one
// run, adding exactly two things around the real decision:
//
//   • visibility — every pending ask is tracked on the LocalWorkflowTask's
//     pendingPermissions map while it waits, so the /workflows board and the
//     transcript result line can honestly say "waiting on N asks";
//   • a fail-closed ceiling for HEADLESS sessions — a stdio/prompt-tool
//     permission driver may block indefinitely with nobody attached, so an
//     unanswered ask eventually aborts the ASKING agent (only that agent) and
//     resolves to a deny. A missing answer is never an allow.
//
// Interactive sessions deliberately get NO ceiling: the ask sits in the
// session's rendered permission queue where the operator can see and answer
// it. A timeout there would be wrong twice — waiting on a present operator is
// the contract, and expiring the promise could not remove the rendered queue
// entry, so the session's FIFO permission queue would wedge behind a dead row.
//
// Bypass/accept-all permission modes never reach this wrapper at all: they
// resolve inside the shared permission gate before canUseTool is invoked.

// Everything below is imported type-only EXCEPT the flag-registry read (a
// registered env value must resolve through the registry). Keeping the value
// graph this small keeps the module loadable in isolation, so a standalone
// proof can drive the real code instead of a re-implementation.
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type {
  LocalWorkflowTaskState,
  PendingWorkflowPermission,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/** Default headless-ask ceiling. Generous on purpose: slow external approvers
 *  are routine, and denying one agent after ten minutes still beats hanging a
 *  phase forever. */
export const DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS = 600_000

// Floor below which a configured ceiling is clamped — a fat-fingered value
// must not turn every ask into an instant deny.
const TIMEOUT_FLOOR_MS = 5_000

/**
 * The active headless-ask ceiling. Reads MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS
 * fresh on every call so a live session honors a changed value without a
 * relaunch. Absent/blank/non-positive/non-numeric values fall back to the
 * default; anything else is floored at TIMEOUT_FLOOR_MS.
 */
export function workflowPermissionTimeoutMs(): number {
  const raw = flagEnv('MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS')
  if (raw === undefined || raw === '') return DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS
  return Math.max(TIMEOUT_FLOOR_MS, Math.floor(parsed))
}

export class WorkflowPermissionTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `Permission request for ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s waiting for operator approval`,
    )
    this.name = 'WorkflowPermissionTimeoutError'
  }
}

export interface WorkflowCanUseToolDeps {
  taskId: string
  setAppState: SetAppState
  /** The session's real canUseTool — WorkflowTool.call()'s 3rd parameter. */
  realCanUseTool: CanUseToolFn
  /**
   * Live view of the run's per-agent abort controllers. Must be the SAME map
   * instance the hooks layer populates via onAgentController, so an expired
   * ask aborts precisely the agent that asked — the single-agent blast
   * radius, never the whole run.
   */
  getAgentControllers: () => Map<string, AbortController> | undefined
  /**
   * Live task reader for the ask LABEL: the consent card names the workflow
   * and the asking agent instead of presenting as an anonymous main-session
   * ask. Optional so leaf provers without app state keep loading.
   */
  getAppState?: () => { tasks?: Record<string, unknown> }
  /** TEST SEAM ONLY: pin the ceiling instead of reading the env. */
  timeoutMsOverride?: number
}

/** The consent-card badge for one workflow ask: `<workflow> · <agent>`.
 *  Pure + exported for the prover. Falls back honestly at each level —
 *  a nameless run still says 'workflow', an unlabelled agent shows its id. */
export function workflowAskBadgeName(
  task:
    | {
        workflowName?: string
        summary?: string
        workflowProgress?: ReadonlyArray<Record<string, unknown>>
      }
    | undefined,
  agentId: string | undefined,
): string {
  const wf = task?.workflowName ?? task?.summary ?? 'workflow'
  if (!agentId) return wf
  const row = task?.workflowProgress?.find(
    r => r['type'] === 'workflow_agent' && r['agentId'] === agentId,
  )
  const agent =
    typeof row?.['label'] === 'string' && (row['label'] as string).length > 0
      ? (row['label'] as string)
      : agentId.slice(0, 8)
  return `${wf} · ${agent}`
}

/**
 * Wrap the session canUseTool for one workflow run. Every elicitation is
 * recorded on the task while pending and is guaranteed to settle — with the
 * operator's real decision, or with a fail-closed deny when a headless ask
 * outlives the ceiling.
 */
export function makeWorkflowCanUseTool(deps: WorkflowCanUseToolDeps): CanUseToolFn {
  // Single-updater state write, inlined rather than imported so the module's
  // value imports stay limited to the flag registry (see the import note).
  // Semantics match the shared task-state helper: missing task → no-op, and a
  // delete of an absent key returns the previous state untouched so no
  // render churn happens for nothing.
  const recordAsk = (
    toolUseID: string,
    entry: PendingWorkflowPermission | undefined,
  ): void => {
    deps.setAppState(prev => {
      const task = prev.tasks?.[deps.taskId] as LocalWorkflowTaskState | undefined
      if (!task) return prev
      if (!entry && !task.pendingPermissions?.has(toolUseID)) {
        return prev
      }
      const pendingPermissions = new Map(task.pendingPermissions)
      if (entry) pendingPermissions.set(toolUseID, entry)
      else pendingPermissions.delete(toolUseID)
      return {
        ...prev,
        tasks: { ...prev.tasks, [deps.taskId]: { ...task, pendingPermissions } },
      }
    })
  }

  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    const agentId = (toolUseContext as { agentId?: string }).agentId
    recordAsk(toolUseID, { agentId, toolName: tool.name, askedAt: Date.now() })
    // Label the ask before it travels: the interactive handler lifts this
    // onto the consent card's badge, so the operator sees WHICH workflow and
    // agent is asking — never an anonymous main-session-looking card.
    try {
      const task = deps.getAppState?.().tasks?.[deps.taskId] as
        | Parameters<typeof workflowAskBadgeName>[0]
        | undefined
      ;(toolUseContext as { workflowAskBadge?: { name: string; color: string } }).workflowAskBadge = {
        name: workflowAskBadgeName(task, agentId),
        color: 'yellow',
      }
    } catch {
      // an unlabelled ask still asks
    }
    try {
      // Attended session: hand the ask to the rendered permission queue and
      // wait for the operator's actual answer, however long that takes.
      if (!toolUseContext.options.isNonInteractiveSession) {
        return await deps.realCanUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
          forceDecision,
        )
      }

      // Headless: no dialog will ever render, and an external permission
      // driver may simply never answer. Race the real decision against the
      // ceiling; on expiry, abort the asking agent FIRST (so its turn cannot
      // sneak one more call through the gap), then settle as a deny.
      const timeoutMs = deps.timeoutMsOverride ?? workflowPermissionTimeoutMs()
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            if (agentId) {
              deps.getAgentControllers()?.get(agentId)?.abort('workflow-permission-timeout')
            }
          } catch {
            // a failed abort must never mask the deny below
          }
          reject(new WorkflowPermissionTimeoutError(tool.name, timeoutMs))
        }, timeoutMs)
      })

      try {
        return await Promise.race([
          deps.realCanUseTool(
            tool,
            input,
            toolUseContext,
            assistantMessage,
            toolUseID,
            forceDecision,
          ),
          expiry,
        ])
      } catch (e) {
        if (e instanceof WorkflowPermissionTimeoutError) {
          const denied: PermissionDecision = {
            behavior: 'deny',
            message: e.message,
            decisionReason: { type: 'asyncAgent', reason: 'workflow-permission-timeout' },
            toolUseID,
          }
          return denied
        }
        throw e
      } finally {
        if (timer) clearTimeout(timer)
      }
    } finally {
      // The pending count must be honest on every exit path, throws included.
      recordAsk(toolUseID, undefined)
    }
  }
}
