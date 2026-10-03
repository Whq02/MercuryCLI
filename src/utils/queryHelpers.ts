import { readFileSync } from 'node:fs'

import { isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { Tool as ToolType, Tools, ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { OrphanedPermission } from '../types/textInputTypes.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { logForDebugging } from './debug.js'
import { isENOENT } from './errors.js'
import { createUserMessage } from './messages.js'
import { toolUseError } from '../services/tools/toolExecution.js'
import { isToolKilled, toolKillReason } from './permissions/capabilityGate.js'
import { expandPath } from './path.js'
import { recordTranscript, flushSessionStorage } from './sessionStorage.js'
import type { ProcessUserInputContext } from './processUserInput/processUserInput.js'


export async function* handleOrphanedPermission(
  orphanedPermission: OrphanedPermission,
  tools: Tools,
  mutableMessages: Message[],
  processUserInputContext: ProcessUserInputContext,
): AsyncGenerator<Message> {
  const decision = orphanedPermission.permissionResult as {
    behavior?: string
    tool_use_id?: string
    updated_input?: Record<string, unknown>
  }
  const toolUseId = decision.tool_use_id
  if (!toolUseId) return
  const assistantMessage = orphanedPermission.assistantMessage
  const content = assistantMessage.message.content
  const toolUseBlock = Array.isArray(content)
    ? (content.find(
        block => (block as { type?: string; id?: string }).type === 'tool_use' && (block as { id?: string }).id === toolUseId,
      ) as { id: string; name: string; input: Record<string, unknown> } | undefined)
    : undefined
  if (!toolUseBlock) return
  const tool = tools.find(candidate => candidate.name === toolUseBlock.name)
  if (!tool) return

  let input = toolUseBlock.input
  if (decision.behavior === 'allow') {
    if (decision.updated_input) {
      input = decision.updated_input
    } else {
      logForDebugging(
        `WARNING: orphaned permission for ${toolUseBlock.name} carried no updated input; using the original input`,
      )
    }
  }

  const alreadyPushed = mutableMessages.some(
    message =>
      message.type === 'assistant' &&
      Array.isArray(message.message.content) &&
      message.message.content.some(
        block => (block as { type?: string; id?: string }).type === 'tool_use' && (block as { id?: string }).id === toolUseId,
      ),
  )
  if (!alreadyPushed) {
    mutableMessages.push(assistantMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([assistantMessage])
      void flushSessionStorage()
    }
  }
  yield assistantMessage

  const settleAsError = (text: string): Message => {
    const errorMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: toolUseError(text),
          is_error: true,
          tool_use_id: toolUseId,
        },
      ] as never,
      toolUseResult: text,
      sourceToolAssistantUUID: assistantMessage.uuid as never,
    })
    mutableMessages.push(errorMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([errorMessage])
      void flushSessionStorage()
    }
    return errorMessage
  }

  if (decision.behavior !== 'allow') {
    const saidNo = decision.behavior === 'deny'
    const reason = (orphanedPermission.permissionResult as { message?: string }).message
    const text = saidNo
      ? `Permission denied${reason ? `: ${reason}` : ''} — the late answer refused ${toolUseBlock.name}; the tool did not run.`
      : `Permission was never granted (the late answer carried ${JSON.stringify(decision.behavior ?? 'no verdict')}) — ${toolUseBlock.name} did not run.`
    logForDebugging(
      `handleOrphanedPermission: non-allow verdict for ${toolUseBlock.name} (${String(decision.behavior)}) — settled as a refusal, tool not invoked`,
    )
    yield settleAsError(text)
    return
  }

  const replayAgentType = (processUserInputContext as { agentType?: string }).agentType
  if (isToolKilled(tool, replayAgentType)) {
    const kill = toolKillReason(tool, replayAgentType)
    const text = `${toolUseBlock.name} is disabled by the operator's kill switch${kill ? ` (${kill.killPattern})` : ''} — the approved call was not run.`
    logForDebugging(`handleOrphanedPermission: ${toolUseBlock.name} killed at replay time — settled as a refusal`)
    yield settleAsError(text)
    return
  }

  const parsedReplayInput = tool.inputSchema.safeParse(input)
  if (!parsedReplayInput.success) {
    yield settleAsError(`InputValidationError: ${parsedReplayInput.error.message}`)
    return
  }

  const permissionFn = async (): Promise<unknown> => ({
    ...orphanedPermission.permissionResult,
    decisionReason: { type: 'mode', mode: 'default' },
  })
  const updates = tool.call(parsedReplayInput.data as never, processUserInputContext as unknown as ToolUseContext, permissionFn as never, assistantMessage as never)
  for await (const update of updates as unknown as AsyncGenerator<{ message?: Message }>) {
    const updateMessage = (update as { message?: Message }).message ?? (update as unknown as Message)
    if (!updateMessage || typeof updateMessage !== 'object' || !('type' in updateMessage)) continue
    mutableMessages.push(updateMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([updateMessage])
      void flushSessionStorage()
    }
    yield updateMessage
  }
}


const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type ToolUseRecord = { path: string; content?: string }

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = DEFAULT_EXTRACT_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)
  const reads = new Map<string, ToolUseRecord>()
  const writes = new Map<string, ToolUseRecord>()
  const edits = new Map<string, ToolUseRecord>()

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const toolUse = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
      if (toolUse.type !== 'tool_use' || !toolUse.id || !toolUse.input) continue
      const filePath = toolUse.input.file_path
      if (typeof filePath !== 'string' || filePath === '') continue
      const absolute = expandPath(filePath, cwd)
      if (toolUse.name === FILE_READ_TOOL_NAME) {
        if (toolUse.input.offset === undefined && toolUse.input.limit === undefined) {
          reads.set(toolUse.id, { path: absolute })
        }
      } else if (toolUse.name === FILE_WRITE_TOOL_NAME) {
        const written = toolUse.input.content
        if (typeof written === 'string' && written !== '') {
          writes.set(toolUse.id, { path: absolute, content: written })
        }
      } else if (toolUse.name === FILE_EDIT_TOOL_NAME) {
        edits.set(toolUse.id, { path: absolute })
      }
    }
  }

  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    const timestamp = (message as { timestamp?: string }).timestamp
    for (const block of content) {
      const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (result.type !== 'tool_result' || !result.tool_use_id) continue
      const read = reads.get(result.tool_use_id)
      if (read) {
        if (typeof result.content !== 'string') continue
        if (result.content.startsWith(FILE_UNCHANGED_STUB)) continue
        if (!timestamp) continue
        const cleaned = result.content
          .replace(SYSTEM_REMINDER_PATTERN, '')
          .split('\n')
          .map(line => stripLineNumberPrefix(line))
          .join('\n')
          .trim()
        cache.set(read.path, { content: cleaned, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const write = writes.get(result.tool_use_id)
      if (write && write.content !== undefined) {
        if (!timestamp) continue
        cache.set(write.path, { content: write.content, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const edit = edits.get(result.tool_use_id)
      if (edit && result.is_error !== true) {
        try {
          const diskContent = readFileSync(edit.path, 'utf8')
          const mtime = getFileModificationTime(edit.path)
          cache.set(edit.path, { content: diskContent, timestamp: mtime, offset: undefined, limit: undefined })
        } catch (err) {
          if (!isENOENT(err) && !(err instanceof Error && (err as NodeJS.ErrnoException).code === 'EACCES')) throw err
        }
      }
    }
  }
  return cache
}


const PREFIX_COMMANDS = new Set(['sudo'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
