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
  userFacingName: () => TESTING_PERMISSION_TOOL_NAME,
  description: async () => 'A test tool that always asks for permission.',
  prompt: async () =>
    'A test tool that always asks for permission before executing. It exists for end-to-end testing of the permission flow.',
  checkPermissions: async () => ({
    behavior: 'ask' as const,
    message: 'Run the testing permission tool?',
  }),
  call: async () => ({
    data: `${TESTING_PERMISSION_TOOL_NAME} executed successfully`,
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
