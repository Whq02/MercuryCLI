import { ProtocolError, ProtocolErrorCode, Server, serveStdio, type Tool as McpTool } from '../utils/mcp/sdk.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../Tool.js'
import { getSessionId } from '../bootstrap/state.js'
import { query } from '../query.js'
import { engageCommitGate } from '../guards/commitGate.js'
import { judgeToolCall } from '../guards/guards.js'
import { registerWardsGuard } from '../guards/wardsGuard.js'
import review from '../commands/review.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { getTools } from '../tools.js'
import { setCwd } from '../utils/Shell.js'
import { logError } from '../utils/log.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { isToolKilled } from '../utils/permissions/capabilityGate.js'
import { COMPUTER_TOOL_NAME } from '../services/desktop/toolName.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { randomUUID } from 'node:crypto'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'
import { createAssistantMessage } from '../services/messages.js'
import { repairToolInput } from '../services/providers/toolCallGate.js'
import { formatZodValidationError } from '../utils/toolErrors.js'
import { notBuilt } from '../pi/holes.js'

export function describeToolError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    const name = error.name.trim()
    if (message === '') return name === '' ? 'Error' : name
    return name === '' || name === 'Error' || message.startsWith(`${name}:`) ? message : `${name}: ${message}`
  }
  const text = String(error).trim()
  return text === '' ? 'Error' : text
}

export function armServedSession(): void {
  registerWardsGuard(() => {}, getSessionId())
  engageCommitGate(getSessionId())
}

export async function servedCallRefusal(tool: Pick<Tool, 'name' | 'shellCommandOf'>, input: Record<string, unknown>, callId: string, signal?: AbortSignal): Promise<string | null> {
  const judgement = await judgeToolCall(getSessionId(), { tool: tool.name, input, callId, messages: [], toolRef: tool as Tool, asksAnswerable: false }, signal)
  return judgement.refused ? judgement.reason : null
}

export async function buildServePermissionContext(): Promise<ReturnType<typeof getEmptyToolPermissionContext>> {
  const context = getEmptyToolPermissionContext()
  const { loadAllPermissionRulesFromDisk } = await import('../utils/permissions/permissionsLoader.js')
  const { applyPermissionRulesToPermissionContext } = await import('../utils/permissions/permissions.js')
  return applyPermissionRulesToPermissionContext(context, loadAllPermissionRulesFromDisk())
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
): Promise<void> {
  return notBuilt('src/entrypoints/mcp.ts:51')
}
