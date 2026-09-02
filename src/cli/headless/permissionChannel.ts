
import { StructuredIO } from 'src/cli/structuredIO.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { toolMatchesName, type Tool } from 'src/Tool.js'
import { createCombinedAbortSignal } from 'src/utils/combinedAbortSignal.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import type { PermissionPromptTool } from 'src/utils/queryHelpers.js'
import type { RequiresActionDetails } from 'src/utils/sessionState.js'

export function createCanUseToolWithPermissionPrompt(
  permissionPromptTool: PermissionPromptTool,
): CanUseToolFn {
  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    const mainPermissionResult =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))

    if (
      mainPermissionResult.behavior === 'allow' ||
      mainPermissionResult.behavior === 'deny'
    ) {
      return mainPermissionResult
    }

    const { signal: combinedSignal, cleanup: cleanupAbortListener } =
      createCombinedAbortSignal(toolUseContext.abortController.signal)

    if (combinedSignal.aborted) {
      cleanupAbortListener()
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    const abortPromise = new Promise<'aborted'>(resolve => {
      combinedSignal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      })
    })

    const toolCallPromise = permissionPromptTool.call(
      {
        tool_name: tool.name,
        input,
        tool_use_id: toolUseId,
      },
      toolUseContext,
      canUseTool,
      assistantMessage,
    )

    const raceResult = await Promise.race([toolCallPromise, abortPromise])
    cleanupAbortListener()

    if (raceResult === 'aborted' || combinedSignal.aborted) {
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    const result = raceResult as Awaited<typeof toolCallPromise>

    const permissionToolResultBlockParam =
      permissionPromptTool.mapToolResultToToolResultBlockParam(result.data, '1')
    if (
      !permissionToolResultBlockParam.content ||
      !Array.isArray(permissionToolResultBlockParam.content) ||
      !permissionToolResultBlockParam.content[0] ||
      permissionToolResultBlockParam.content[0].type !== 'text' ||
      typeof permissionToolResultBlockParam.content[0].text !== 'string'
    ) {
      throw new Error(
        'Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.',
      )
    }
    return permissionPromptToolResultToPermissionDecision(
      permissionToolOutputSchema().parse(
        safeParseJSON(permissionToolResultBlockParam.content[0].text),
      ),
      permissionPromptTool,
      input,
      toolUseContext,
    )
  }
  return canUseTool
}

export function getCanUseToolFn(
  permissionPromptToolName: string | undefined,
  structuredIO: StructuredIO,
  getMcpTools: () => Tool[],
  onPermissionPrompt?: (details: RequiresActionDetails) => void,
): CanUseToolFn {
  if (permissionPromptToolName === 'stdio') {
    return structuredIO.createCanUseTool(onPermissionPrompt)
  }
  if (!permissionPromptToolName) {
    return async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    ) =>
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))
  }
  let resolved: CanUseToolFn | null = null
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    if (!resolved) {
      const mcpTools = getMcpTools()
      const permissionPromptTool = mcpTools.find(t =>
        toolMatchesName(t, permissionPromptToolName),
      ) as PermissionPromptTool | undefined
      if (!permissionPromptTool) {
        const error = `Error: MCP tool ${permissionPromptToolName} (passed via --permission-prompt-tool) not found. Available MCP tools: ${mcpTools.map(t => t.name).join(', ') || 'none'}`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      if (!permissionPromptTool.inputJSONSchema) {
        const error = `Error: tool ${permissionPromptToolName} (passed via --permission-prompt-tool) must be an MCP tool`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      resolved = createCanUseToolWithPermissionPrompt(permissionPromptTool)
    }
    return resolved(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    )
  }
}
