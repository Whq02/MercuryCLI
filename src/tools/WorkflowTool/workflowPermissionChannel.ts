
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type {
  LocalWorkflowTaskState,
  PendingWorkflowPermission,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export const DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS = 600_000

const TIMEOUT_FLOOR_MS = 5_000

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
  realCanUseTool: CanUseToolFn
  getAgentControllers: () => Map<string, AbortController> | undefined
  getAppState?: () => { tasks?: Record<string, unknown> }
  timeoutMsOverride?: number
}

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

export function makeWorkflowCanUseTool(deps: WorkflowCanUseToolDeps): CanUseToolFn {
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
    try {
      const task = deps.getAppState?.().tasks?.[deps.taskId] as
        | Parameters<typeof workflowAskBadgeName>[0]
        | undefined
      ;(toolUseContext as { workflowAskBadge?: { name: string; color: string } }).workflowAskBadge = {
        name: workflowAskBadgeName(task, agentId),
        color: 'yellow',
      }
    } catch {
    }
    try {
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

      const timeoutMs = deps.timeoutMsOverride ?? workflowPermissionTimeoutMs()
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            if (agentId) {
              deps.getAgentControllers()?.get(agentId)?.abort('workflow-permission-timeout')
            }
          } catch {
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
      recordAsk(toolUseID, undefined)
    }
  }
}
