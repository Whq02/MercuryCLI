import { registerHookCallbacks } from '../bootstrap/state.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { HookInput } from './hooks/contract.js'

import type { HookJSONOutput } from './hooks/contract.js'

import { detectSessionFileType, detectSessionPatternType } from './memoryFileDetection.js'


type SessionFileType = 'session_memory' | 'session_transcript' | null

function classifySessionAccess(toolName: string, toolInput: unknown): SessionFileType {
  const input = (toolInput ?? {}) as { file_path?: unknown; path?: unknown; pattern?: unknown; glob?: unknown }
  switch (toolName) {
    case FILE_READ_TOOL_NAME:
      return typeof input.file_path === 'string' ? detectSessionFileType(input.file_path) : null
    case GREP_TOOL_NAME: {
      if (typeof input.path === 'string') return detectSessionFileType(input.path)
      if (typeof input.glob === 'string') return detectSessionPatternType(input.glob)
      return null
    }
    case GLOB_TOOL_NAME: {
      if (typeof input.path === 'string') return detectSessionFileType(input.path)
      return typeof input.pattern === 'string' ? detectSessionPatternType(input.pattern) : null
    }
    default:
      return null
  }
}

async function hookBody(input: HookInput): Promise<HookJSONOutput> {
  try {
    const record = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown }
    if (record.hook_event_name !== 'PostToolUse') return {} as HookJSONOutput
    classifySessionAccess(record.tool_name ?? '', record.tool_input)
    return {} as HookJSONOutput
  } catch {
    return {} as HookJSONOutput
  }
}

export function registerSessionFileAccessHooks(): void {
  const callback = {
    type: 'callback' as const,
    callback: (input: HookInput) => hookBody(input),
    timeout: 1,
    internal: true,
  }
  registerHookCallbacks({
    PostToolUse: [
      FILE_READ_TOOL_NAME,
      GREP_TOOL_NAME,
      GLOB_TOOL_NAME,
      FILE_EDIT_TOOL_NAME,
      FILE_WRITE_TOOL_NAME,
    ].map(matcher => ({ matcher, hooks: [callback] })),
  })
}
