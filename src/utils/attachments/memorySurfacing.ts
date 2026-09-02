
import type { Message } from 'src/types/message.js'
import {
  experienceCardsEnabled,
  fullScanSecretRefusal,
  isExperienceCardMarkdown,
  renderExperienceCardForRecall,
} from '../../memdir/experienceCards.js'
import { findRelevantMemories } from '../../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../../memdir/memoryAge.js'
import { referentNote, verifyMemoryReferents } from '../../memdir/memoryReferents.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
  relevantMemoryRecallEnabled,
} from '../../memdir/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { createChildAbortController } from '../abortController.js'
import { isAbortError } from '../errors.js'
import { cacheKeys, type FileStateCache } from '../fileStateCache.js'
import { logError } from '../log.js'
import { getUserMessageText } from '../messages.js'
import { isHumanTurn } from '../messagePredicates.js'
import { readFileInRange } from '../readFileInRange.js'
import { isToolResultBlock } from './shared.js'
import { RELEVANT_MEMORIES_CONFIG, type Attachment } from './types.js'
import { extractAgentMentions } from './mentions.js'

const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096

const SECRET_SCAN_MAX_LINES = 50_000
const SECRET_SCAN_MAX_BYTES = 5_000_000


async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<Attachment[]> {
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
      ).catch(() => []),
    ),
  )
  const selected = allResults
    .flat()
    .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)

  const memories = await readMemoriesForSurfacing(selected, signal)

  if (memories.length === 0) {
    return []
  }
  return [{ type: 'relevant_memories' as const, memories }]
}

export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          { truncateOnByteLimit: true },
        )
        const truncated =
          result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        let rendered: string
        if (!experienceCardsEnabled()) {
          rendered = content
        } else if (truncated) {
          let full: string | null
          try {
            const fullRes = await readFileInRange(
              filePath,
              0,
              SECRET_SCAN_MAX_LINES,
              SECRET_SCAN_MAX_BYTES,
              signal,
              { truncateOnByteLimit: true },
            )
            full =
              fullRes.truncatedByBytes || fullRes.totalLines > SECRET_SCAN_MAX_LINES
                ? null
                : fullRes.content
          } catch {
            full = null
          }
          const refusal = fullScanSecretRefusal(full)
          rendered = refusal
            ? refusal
            : full !== null && isExperienceCardMarkdown(full)
              ?
                renderExperienceCardForRecall(content, full, mtimeMs)
              : content
        } else {
          rendered = renderExperienceCardForRecall(content, undefined, mtimeMs)
        }
        const referents = verifyMemoryReferents(result.content, { projectRoot: getProjectRoot() })
        if (referents.missing.length > 0) rendered += referentNote(referents)
        return {
          path: filePath,
          content: rendered,
          mtimeMs: result.mtimeMs,
          header: memoryHeader(filePath, result.mtimeMs),
          limit: truncated ? result.lineCount : undefined,
          rawContent: rendered !== result.content ? result.content : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}

export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
  [Symbol.dispose](): void
}

export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (!isAutoMemoryEnabled() || !relevantMemoryRecallEnabled()) {
    return undefined
  }

  const lastUserMessage = messages.findLast((m: Message) => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}


export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): readonly string[] {
  const useIdToName = new Map<string, string>()
  const resultByUseId = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (isHumanTurn(m) && m !== lastUserMessage) break
    if (m.type === 'assistant' && typeof m.message.content !== 'string') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') useIdToName.set(block.id, block.name)
      }
    } else if (
      m.type === 'user' &&
      'message' in m &&
      Array.isArray(m.message.content)
    ) {
      for (const block of m.message.content) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.tool_use_id, block.is_error === true)
        }
      }
    }
  }
  const failed = new Set<string>()
  const succeeded = new Set<string>()
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id)
    if (errored === undefined) continue
    if (errored) {
      failed.add(name)
    } else {
      succeeded.add(name)
    }
  }
  return [...succeeded].filter(t => !failed.has(t))
}


export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),
      )
      for (const m of filtered) {
        readFileState.set(m.path, {
          content: m.rawContent ?? m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
          isPartialView: m.rawContent !== undefined,
        })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}
