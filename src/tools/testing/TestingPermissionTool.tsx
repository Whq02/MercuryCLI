import { z } from 'zod'

import { buildTool } from '../../Tool.js'

const TESTING_PERMISSION_TOOL_NAME = 'TestingPermission'

const inputSchema = z.strictObject({})

export const TestingPermissionTool = buildTool({
  name: TESTING_PERMISSION_TOOL_NAME,
  inputSchema,
  maxResultSizeChars: 100_000,
  isEnabled: () => process.env.NODE_ENV === 'test',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  description: async () => 'Testing tool that always asks for permission.',
  prompt: async () => 'Testing tool that always asks for permission.',
  checkPermissions: async input => ({
    behavior: 'ask' as const,
    message: 'Run the testing permission tool?',
    updatedInput: input,
  }),
  call: async () => ({
    data: 'TestingPermission executed successfully',
  }),
  mapToolResultToToolResultBlockParam(output: string, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: output,
    }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
  renderToolResultMessage: () => null,
})
