import { z } from 'zod'

import { buildTool } from '../../Tool.js'

/**
 * A test-only tool whose entire purpose is to reliably trigger the
 * permission dialog for end-to-end tests: its permission check
 * unconditionally asks. Registered only under a test environment (the
 * registry additionally gates on runtime NODE_ENV === 'test'); the
 * enablement predicate compares the build-folded environment literal, so a
 * production build folds it constant-false.
 */

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
  async description(): Promise<string> {
    return 'A test tool that always asks for permission.'
  },
  async prompt(): Promise<string> {
    return 'A test tool that always asks for permission before executing. It exists for end-to-end testing of the permission flow.'
  },
  async checkPermissions() {
    return {
      behavior: 'ask' as const,
      message: 'Run the testing permission tool?',
    }
  },
  async call() {
    return { data: `${TESTING_PERMISSION_TOOL_NAME} executed successfully` }
  },
  mapToolResultToToolResultBlockParam(output: string, toolUseID: string) {
    // The result string as-is — no JSON quoting.
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: output }
  },
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
})
