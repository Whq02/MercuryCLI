import { registerHookCallbacks } from '../bootstrap/state.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { HookInput } from '../entrypoints/agentSdkTypes.js'
import type { HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import { detectSessionFileType, detectSessionPatternType, isAutoMemFile } from './memoryFileDetection.js'

/**
 * One internal post-tool-use hook against the five file tools, classifying
 * accesses to session-memory / transcript / auto-memory files. The
 * classification branches are extension points: the telemetry that consumed
 * them was removed, so the hook classifies and emits nothing.
 */

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
      // The glob pattern is required, so it is always consulted.
      return typeof input.pattern === 'string' ? detectSessionPatternType(input.pattern) : null
    }
    default:
      return null
  }
}

/** Auto-memory path extraction covers read, edit and write; anything else yields nothing. */
function extractFilePath(toolName: string, toolInput: unknown): string | null {
  if (toolName !== FILE_READ_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME && toolName !== FILE_WRITE_TOOL_NAME) return null
  const input = (toolInput ?? {}) as { file_path?: unknown }
  return typeof input.file_path === 'string' ? input.file_path : null
}

/** Did this tool use touch a memory file — session memory, or an auto-memory path. */
export function isMemoryFileAccess(toolName: string, toolInput: unknown): boolean {
  if (classifySessionAccess(toolName, toolInput) === 'session_memory') return true
  const path = extractFilePath(toolName, toolInput)
  return path !== null && isAutoMemFile(path)
}

/** Ignores non-post-tool-use events, classifies, and returns an empty result. Never throws. */
async function hookBody(input: HookInput): Promise<HookJSONOutput> {
  try {
    const record = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown }
    if (record.hook_event_name !== 'PostToolUse') return {} as HookJSONOutput
    classifySessionAccess(record.tool_name ?? '', record.tool_input)
    // Extension point: the emissions that consumed the classification were
    // removed.
    return {} as HookJSONOutput
  } catch {
    return {} as HookJSONOutput
  }
}

/** Five matcher entries sharing one callback object; timeout 1 (it only classifies); marked internal. */
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
