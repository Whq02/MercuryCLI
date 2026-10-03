import { randomUUID } from 'node:crypto'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Capabilities, ElicitationAnswer, ElicitationRequestParams, PermissionAnswer, PermissionRequestParams } from '../../runner/wire/methods.js'
import type { Peer } from '../../runner/wire/peer.js'
import { PeerClosed } from '../../runner/wire/peer.js'
import type { ElicitResult } from '../../services/mcp/sdk.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { PermissionRequestResult } from '../../types/hooks.js'
import type { PermissionDecision, PermissionDecisionReason, PermissionUpdate } from '../../types/permissions.js'
import { formatLimit, isDeadlineExceeded } from '../../utils/deadline.js'
import { logForDebugging } from '../../utils/debug.js'
import { executePermissionRequestHooks } from '../../utils/hooks.js'
import { UNANSWERED_ASK_REJECT_MESSAGE, turnCutOf } from '../../utils/messages/rejectionText.js'
import { encodeDecisionReasonForWire } from '../../utils/permissions/decisionReasonWire.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { applyPermissionUpdates, persistPermissionUpdates } from '../../utils/permissions/PermissionUpdate.js'
import { notifySessionStateChanged, type RequiresActionDetails } from '../../utils/sessionState.js'
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from '../../daemon/runnerFrames.js'

export { SANDBOX_NETWORK_ACCESS_TOOL_NAME }

export const PERMISSION_CHANNEL_CLOSED_CAUSE = 'the permission channel closed while the ask was pending'

export function unansweredAskCause(reason: unknown): string | undefined {
  if (reason === 'workflow-permission-timeout') return 'the permission ask timed out'
  if (turnCutOf(reason).kind !== 'idle-timeout') return undefined
  const limitMs = isDeadlineExceeded(reason) ? (reason as { limitMs?: unknown }).limitMs : undefined
  return typeof limitMs === 'number' && Number.isFinite(limitMs) && limitMs > 0
    ? `nobody answered within ${formatLimit(limitMs)}, the turn's no-progress limit`
    : "nobody answered before the turn's no-progress timeout"
}

export class AskAborted extends Error {
  constructor(message = 'the ask was aborted') {
    super(message)
    this.name = 'AskAborted'
  }
}

export type ToolAskParams = Extract<PermissionRequestParams, { kind: 'tool' }>

export interface AskChannel {
  askPermission(params: PermissionRequestParams, opts: { signal?: AbortSignal; key: string }): Promise<PermissionAnswer>
  parkedAsks(): number
}

export interface AskHost extends AskChannel {
  createCanUseTool(onPermissionPrompt?: (details: RequiresActionDetails) => void): CanUseToolFn
  handleElicitation(serverName: string, message: string, requestedSchema?: Record<string, unknown>, signal?: AbortSignal, mode?: 'form' | 'url', url?: string, elicitationId?: string): Promise<ElicitResult>
  createSandboxAskCallback(): (ask: { host: string; port?: number }) => Promise<boolean>
  denyPendingPermissionRequests(cause: string): number
  pendingControlRequestCount(): number
  setOnControlRequestSent(cb: (() => void) | undefined): void
  setOnControlRequestResolved(cb: (() => void) | undefined): void
}

export function serializeDecisionReason(reason: unknown): string | undefined {
  if (!reason || typeof reason !== 'object') return undefined
  const typed = reason as { type?: string; reason?: string; hookName?: string }
  switch (typed.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResult':
    case 'permissionPromptTool':
      return undefined
    default: {
      if (typeof typed.reason === 'string' && typed.reason.length > 0) return typed.reason
      return undefined
    }
  }
}

export function describeToolAction(tool: Tool, input: Record<string, unknown>): string {
  try {
    const described =
      (tool as { getActivityDescription?: (i: unknown) => string | null }).getActivityDescription?.(input) ??
      (tool as { getToolUseSummary?: (i: unknown) => string | null }).getToolUseSummary?.(input) ??
      (tool as { userFacingName?: (i: unknown) => string }).userFacingName?.(input)
    return described || tool.name
  } catch {
    return tool.name
  }
}

export function decisionOfAnswer(
  answer: PermissionAnswer,
  tool: Tool,
  originalInput: Record<string, unknown>,
  toolUseContext: Pick<ToolUseContext, 'abortController' | 'setAppState'>,
): PermissionDecision {
  if (answer.outcome === 'allow') {
    const updatedInput = answer.input !== undefined && Object.keys(answer.input).length > 0 ? answer.input : originalInput
    if (answer.rules !== undefined && answer.rules.length > 0) {
      const updates = answer.rules as PermissionUpdate[]
      persistPermissionUpdates(updates)
      toolUseContext.setAppState(previous => {
        const updated = applyPermissionUpdates(previous.toolPermissionContext, updates)
        return updated === previous.toolPermissionContext ? previous : { ...previous, toolPermissionContext: updated }
      })
    }
    return {
      behavior: 'allow',
      updatedInput,
      userModified: false,
      decisionReason: { type: 'permissionPromptTool', permissionPromptToolName: tool.name, toolResult: answer },
    }
  }
  if (answer.stop === true) toolUseContext.abortController.abort()
  return {
    behavior: 'deny',
    message: answer.message ?? 'Permission denied by the SDK host',
    decisionReason: { type: 'permissionPromptTool', permissionPromptToolName: tool.name, toolResult: answer },
  }
}

export function createHostCanUseTool(channel: AskChannel, onPermissionPrompt?: (details: RequiresActionDetails) => void): CanUseToolFn {
  const canUseTool: CanUseToolFn = async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    const key = randomUUID()
    const parentSignal = toolUseContext.abortController.signal
    const requestController = new AbortController()
    const forwardParentAbort = (): void => requestController.abort(parentSignal.reason)
    parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
    try {
      const engineResult = (forceDecision ?? (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID))) as PermissionDecision
      if (engineResult.behavior === 'allow' || engineResult.behavior === 'deny') return engineResult

      const permissionMode = (toolUseContext.getAppState() as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode
      const askResult = engineResult as { suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: PermissionDecisionReason }

      onPermissionPrompt?.({
        tool_name: tool.name,
        action_description: describeToolAction(tool as Tool, input),
        tool_use_id: toolUseID,
        request_id: key,
        input,
      })

      const hookDecisionPromise = (async (): Promise<PermissionRequestResult | null> => {
        for await (const result of executePermissionRequestHooks(tool.name, toolUseID, input, toolUseContext, permissionMode, askResult.suggestions, parentSignal)) {
          const decision = result.permissionRequestResult
          if (decision) return decision
        }
        return null
      })()

      const reason = serializeDecisionReason(askResult.decisionReason)
      const reasonDetail = encodeDecisionReasonForWire(askResult.decisionReason)
      const params: ToolAskParams = {
        kind: 'tool',
        tool_use_id: toolUseID,
        tool_name: tool.name,
        input,
        ...(askResult.suggestions !== undefined && askResult.suggestions.length > 0 ? { suggestions: askResult.suggestions } : {}),
        ...(askResult.blockedPath !== undefined ? { blocked_path: askResult.blockedPath } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(reasonDetail !== undefined ? { reason_detail: reasonDetail } : {}),
        ...(toolUseContext.agentId !== undefined ? { agent_id: toolUseContext.agentId } : {}),
      }
      const requestPromise = channel.askPermission(params, { signal: requestController.signal, key })

      const raceOutcome = await Promise.race([
        hookDecisionPromise.then(decision => ({ source: 'hook' as const, decision })),
        requestPromise.then(answer => ({ source: 'host' as const, answer })),
      ])

      if (raceOutcome.source === 'hook' && raceOutcome.decision) {
        const hookDecision = raceOutcome.decision
        requestController.abort()
        requestPromise.catch(() => {})
        if (hookDecision.behavior === 'allow') {
          if (hookDecision.updatedPermissions?.length) {
            persistPermissionUpdates(hookDecision.updatedPermissions)
            toolUseContext.setAppState(previous => {
              const updated = applyPermissionUpdates(previous.toolPermissionContext, hookDecision.updatedPermissions ?? [])
              return updated === previous.toolPermissionContext ? previous : { ...previous, toolPermissionContext: updated }
            })
          }
          return {
            behavior: 'allow',
            updatedInput: hookDecision.updatedInput ?? input,
            userModified: false,
            decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
          }
        }
        return {
          behavior: 'deny',
          message: hookDecision.message ?? 'The PermissionRequest hook denied this permission request',
          decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
        }
      }

      const answer = raceOutcome.source === 'host' ? raceOutcome.answer : await requestPromise
      return decisionOfAnswer(answer, tool as Tool, input, toolUseContext)
    } catch (error) {
      const unanswered = parentSignal.aborted ? unansweredAskCause(parentSignal.reason) : undefined
      if (unanswered !== undefined) {
        return decisionOfAnswer({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(tool.name, unanswered) }, tool as Tool, input, toolUseContext)
      }
      return {
        behavior: 'deny',
        message: `Tool permission request failed: ${error instanceof Error ? error.message : String(error)}`,
        decisionReason: { type: 'other', reason: 'permission request failed' },
      }
    } finally {
      parentSignal.removeEventListener('abort', forwardParentAbort)
      if (channel.parkedAsks() === 0) notifySessionStateChanged('running')
    }
  }
  return canUseTool
}

export function createSandboxAsk(channel: AskChannel): (ask: { host: string; port?: number }) => Promise<boolean> {
  return async ask => {
    try {
      const answer = await channel.askPermission({ kind: 'network', host: ask.host }, { key: randomUUID() })
      return answer.outcome === 'allow'
    } catch {
      return false
    }
  }
}

type ParkedAsk = {
  id: number | null
  toolName: string
  settle: (answer: PermissionAnswer) => void
}

export function createRunnerAsks(peer: Peer, capabilities: () => Capabilities): AskHost {
  const parked = new Map<string, ParkedAsk>()
  let onParked: (() => void) | undefined
  let onSettled: (() => void) | undefined

  const askPermission = (params: PermissionRequestParams, opts: { signal?: AbortSignal; key: string }): Promise<PermissionAnswer> => {
    if (peer.closed) return Promise.reject(new PeerClosed('permission/request', 'the runner door is closed'))
    if (opts.signal?.aborted) return Promise.reject(new AskAborted('the ask was aborted before it was sent'))
    return new Promise<PermissionAnswer>((resolve, reject) => {
      let settled = false
      const entry: ParkedAsk = {
        id: null,
        toolName: params.kind === 'tool' ? params.tool_name : SANDBOX_NETWORK_ACCESS_TOOL_NAME,
        settle: answer => {
          if (settled) return
          settled = true
          parked.delete(opts.key)
          if (entry.id !== null) peer.cancel(entry.id, 'settled by the runner')
          onSettled?.()
          resolve(answer)
        },
      }
      parked.set(opts.key, entry)
      onParked?.()
      const finish = (): void => {
        if (settled) return
        settled = true
        parked.delete(opts.key)
        onSettled?.()
      }
      const sent = peer.send('permission/request', params, { deadlineMs: null, signal: opts.signal })
      entry.id = sent.id
      sent.answer
        .then(answer => {
          if (settled) return
          finish()
          resolve(answer)
        })
        .catch((error: unknown) => {
          if (settled) return
          finish()
          if (error instanceof PeerClosed) {
            resolve({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(entry.toolName, PERMISSION_CHANNEL_CLOSED_CAUSE) })
            return
          }
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  const channel: AskChannel = { askPermission, parkedAsks: () => parked.size }

  return {
    ...channel,
    createCanUseTool: onPermissionPrompt => createHostCanUseTool(channel, onPermissionPrompt),
    createSandboxAskCallback: () => createSandboxAsk(channel),
    async handleElicitation(serverName, message, requestedSchema, signal, mode, url, elicitationId): Promise<ElicitResult> {
      if (!capabilities().elicitation) {
        logForDebugging(`elicitation for ${serverName}: the host declared no elicitation; answered cancel`)
        return { action: 'cancel' } as ElicitResult
      }
      const params: ElicitationRequestParams = {
        server: serverName,
        message,
        ...(mode !== undefined ? { mode } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(elicitationId !== undefined ? { elicitation_id: elicitationId } : {}),
        ...(requestedSchema !== undefined ? { schema: requestedSchema } : {}),
      }
      try {
        const answer: ElicitationAnswer = await peer.request('elicitation/request', params, { deadlineMs: null, signal })
        return answer as ElicitResult
      } catch (error) {
        logForDebugging(`elicitation for ${serverName} failed; resolving as cancel: ${error instanceof Error ? error.message : String(error)}`)
        return { action: 'cancel' } as ElicitResult
      }
    },
    denyPendingPermissionRequests(cause) {
      let settledCount = 0
      for (const entry of [...parked.values()]) {
        entry.settle({ outcome: 'deny', message: UNANSWERED_ASK_REJECT_MESSAGE(entry.toolName, cause) })
        settledCount++
      }
      return settledCount
    },
    pendingControlRequestCount: () => peer.pendingCount,
    setOnControlRequestSent: cb => {
      onParked = cb
    },
    setOnControlRequestResolved: cb => {
      onSettled = cb
    },
  }
}
