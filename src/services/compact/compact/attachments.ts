import { getInvokedSkillsForAgent } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, AttachmentMessage, Message, UserMessage } from '../../../types/message.js'
import { getAgentRosterAttachment, queuedNoticeTaskIds } from '../../../utils/attachments/agentRoster.js'
import { getPlannedDeferredToolsAttachment, getMcpInstructionsDeltaAttachment } from '../../../utils/attachments/deltas.js'
import { generateFileAttachment } from '../../../utils/attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../../utils/attachments/orchestrator.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { getUserContextAttachment } from '../../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../../utils/config/derived.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getCommandQueue } from '../../../utils/messageQueueManager.js'
import { MEMORY_TYPE_VALUES } from '../../../utils/memory/types.js'
import { expandPath } from '../../../utils/path.js'
import type { FileState } from '../../../utils/fileStateCache.js'
import { isInstructionFilePath } from '../../../services/instructions/engine.js'
import { roughTokenCountEstimation } from '../../tokenEstimation.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../../utils/toolResultStorage.js'
import { REPEATED_RESULT_TAG } from '../../../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB, MAX_LINES_TO_READ } from '../../../tools/FileReadTool/prompt.js'
import { estimateContextTokens } from '../microCompact.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE, POST_COMPACT_MAX_TOKENS_PER_SKILL, POST_COMPACT_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD } from './limits.js'
import { type CompactionResult, buildPostCompactMessages } from './result.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'

function shouldExcludeFromPostCompactRestore(filename: string): boolean {
  const normalizedFilename = expandPath(filename)
  if (isInstructionFilePath(normalizedFilename)) return true
  try {
    const memoryPaths = MEMORY_TYPE_VALUES.map(memoryType => expandPath(getMemoryPath(memoryType)))
    if (memoryPaths.includes(normalizedFilename)) return true
  } catch (error) {
    passedOver(error)
  }
  return false
}

export function collectPreservedReadPaths(preserved: Message[], resultIds?: ReadonlySet<string>): Set<string> {
  const stubToolUseIds = new Set<string>()
  const shownToolUseIds = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'user') continue
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') continue
      const text =
        typeof record.content === 'string'
          ? record.content
          : Array.isArray(record.content)
            ? record.content.map(item => String((item as { text?: unknown }).text ?? '')).join('')
            : ''
      if (text.includes(FILE_UNCHANGED_STUB) || text.startsWith(FOLDED_RESULT_KEY) || text.startsWith(REPEATED_RESULT_TAG)) stubToolUseIds.add(record.tool_use_id)
      else if (resultIds?.has(record.tool_use_id) && record.is_error !== true && text !== '' && !text.startsWith(PERSISTED_OUTPUT_TAG) && !text.startsWith(TOOL_RESULT_CLEARED_MESSAGE)) shownToolUseIds.add(record.tool_use_id)
    }
  }
  const paths = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'assistant') continue
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; id?: string; name?: string; input?: { file_path?: unknown } }
      if (record.type !== 'tool_use' || record.name !== FILE_READ_TOOL_NAME) continue
      if (typeof record.id === 'string' && stubToolUseIds.has(record.id)) continue
      if (resultIds !== undefined && (typeof record.id !== 'string' || !shownToolUseIds.has(record.id))) continue
      const filePath = record.input?.file_path
      if (typeof filePath === 'string') paths.add(expandPath(filePath))
    }
  }
  return paths
}

export function linesWithinTokenCeiling(lines: readonly string[], maxTokens: number): number {
  let shown = ''
  for (let count = 0; count < lines.length; count++) {
    shown += `${lines[count]!}\n`
    if (roughTokenCountEstimation(shown) > maxTokens) return Math.max(1, count)
  }
  return lines.length
}

export function fitFileAttachmentToTokenCeiling<T extends Attachment>(row: T, maxTokens: number): T {
  if (row.type !== 'file' || row.content.type !== 'text') return row
  const lines = row.content.file.content.split('\n')
  const count = linesWithinTokenCeiling(lines, maxTokens)
  if (count >= lines.length) return row
  const shown = lines.slice(0, count)
  return { ...row, truncated: true, content: { ...row.content, file: { ...row.content.file, content: shown.join('\n'), numLines: shown.length } } }
}

export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
  project = false,
): Promise<AttachmentMessage[]> {
  const preservedReads = collectPreservedReadPaths(preservedMessages)
  const candidates = Object.entries(readFileState)
    .filter(([path]) => !shouldExcludeFromPostCompactRestore(path))
    .filter(([path]) => !preservedReads.has(expandPath(path)))
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles)

  const generated = project
    ? candidates.map(([path, state]) => {
      const lines = state.content.split('\n')
      return {
        type: 'file' as const, filename: path, displayPath: path,
        content: { type: 'text' as const, file: { filePath: path, content: state.content, numLines: lines.length, startLine: 1, totalLines: lines.length } },
      }
    })
    : await Promise.all(
      candidates.map(([path]) =>
        generateFileAttachment(path, toolUseContext, 'compact', {
          limit: MAX_LINES_TO_READ,
        }).catch(passedOverAs(null)),
      ),
    )

  const results: AttachmentMessage[] = []
  let total = 0
  for (const attachment of generated) {
    if (attachment === null) continue
    const message = createAttachmentMessage(fitFileAttachmentToTokenCeiling(attachment, POST_COMPACT_MAX_TOKENS_PER_FILE))
    const estimate = roughTokenCountEstimation(JSON.stringify(message))
    if (total + estimate > POST_COMPACT_TOKEN_BUDGET) continue
    total += estimate
    results.push(message)
  }
  return results
}

const SKILL_TRUNCATION_MARKER =
  '\n\n[Skill content truncated for compaction — Read the skill path above for the full text.]'

function truncateToTokenCeiling(
  content: string,
  maxTokens: number,
  marker: string,
): { content: string; truncated: boolean } {
  const budget = maxTokens * 4 - marker.length
  if (content.length <= budget) return { content, truncated: false }
  return { content: content.slice(0, Math.max(0, budget)) + marker, truncated: true }
}

function truncateSkillContent(content: string, maxTokens: number): { content: string; truncated: boolean } {
  return truncateToTokenCeiling(content, maxTokens, SKILL_TRUNCATION_MARKER)
}


const POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES = ['file', 'compact_file_reference', 'invoked_skills'] as const

export type PostCompactFit = {
  result: CompactionResult
  estimate: number
  shed: string[]
}

function describeAttachment(message: AttachmentMessage): string {
  const attachment = message.attachment as { type: string; filename?: string }
  if (attachment.type === 'file' || attachment.type === 'compact_file_reference') return `file ${attachment.filename ?? '?'}`
  if (attachment.type === 'compact_operator_messages') return 'operator messages'
  return attachment.type
}

export function fitPostCompactUnderThreshold(result: CompactionResult, threshold: number, count = estimateContextTokens): PostCompactFit {
  let current = result
  let estimate = count(buildPostCompactMessages(current))
  const shed: string[] = []
  for (const kind of POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES) {
    while (estimate >= threshold) {
      let victim = -1
      let victimSize = -1
      current.attachments.forEach((message, index) => {
        if (message.attachment.type !== kind) return
        const size = estimateContextTokens([message])
        if (size > victimSize) {
          victim = index
          victimSize = size
        }
      })
      if (victim < 0) break
      shed.push(describeAttachment(current.attachments[victim] as AttachmentMessage))
      current = { ...current, attachments: current.attachments.filter((_, index) => index !== victim) }
      estimate = count(buildPostCompactMessages(current))
    }
    if (estimate < threshold) break
  }
  return { result: current, estimate, shed }
}

export function obligationsOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: the fixed material (${estimate} tokens: the system prompt, the tool definitions ` +
    `and this stretch's messages) exceeds the window's ceiling (${threshold} tokens) — ` +
    `compaction cannot run here, so no summary was requested and the original context is kept whole; nothing moved. Start a fresh conversation with /clear, ` +
    `or switch to a model with a larger window.`
  )
}

export function postCompactOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: with every restorable attachment dropped, the summary, ` +
    `the kept tail and the session-start hook output still estimate ${estimate} tokens against a ` +
    `${threshold}-token threshold. The original context is kept whole; nothing moved. Start a fresh conversation with /clear, or trim the hook output.`
  )
}

export function createSkillAttachmentIfNeeded(
  agentId?: string,
  catalogue?: ReadonlyArray<{ name: string }>,
): AttachmentMessage | null {
  const invoked = getInvokedSkillsForAgent(agentId)
  if (invoked.size === 0) return null
  const inCatalogue = (name: string): boolean => catalogue === undefined || catalogue.some(command => command.name === name)
  const sorted = [...invoked.values()]
    .filter(skill => {
      if (inCatalogue(skill.skillName)) return true
      logForDebugging(`compact: invoked skill ${skill.skillName} left the catalogue — not re-injected`)
      return false
    })
    .sort((a, b) => b.invokedAt - a.invokedAt)
  const skills: Array<{ name: string; path: string; content: string }> = []
  let total = 0
  for (const skill of sorted) {
    const { content } = truncateSkillContent(skill.content, POST_COMPACT_MAX_TOKENS_PER_SKILL)
    const estimate = roughTokenCountEstimation(content)
    if (total + estimate > POST_COMPACT_SKILLS_TOKEN_BUDGET) continue
    total += estimate
    skills.push({ name: skill.skillName, path: skill.skillPath, content })
  }
  if (skills.length === 0) return null
  return createAttachmentMessage({ type: 'invoked_skills', skills })
}

export async function createAsyncAgentAttachmentsIfNeeded(context: ToolUseContext): Promise<AttachmentMessage[]> {
  const state = context.getAppState()
  return getAgentRosterAttachment({
    tasks: state.tasks,
    agentNameRegistry: state.agentNameRegistry,
    excludeAgentId: context.agentId,
    queuedNoticeIds: queuedNoticeTaskIds(getCommandQueue()),
  }).map(createAttachmentMessage)
}

export function snapshotAndClearReadState(context: ToolUseContext): Record<string, { content: string; timestamp: number }> {
  const snapshot: Record<string, { content: string; timestamp: number }> = {}
  for (const [path, state] of context.readFileState.entries()) {
    snapshot[path] = { content: state.content, timestamp: state.timestamp }
  }
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()
  return snapshot
}

export function restorePreservedReads(
  context: ToolUseContext,
  ledger: Array<[string, FileState]>,
  preserved: Message[],
): string[] {
  const preservedReads = collectPreservedReadPaths(preserved)
  const restored: string[] = []
  for (const [path, state] of ledger) {
    if (!preservedReads.has(expandPath(path))) continue
    context.readFileState.set(path, state)
    restored.push(path)
  }
  return restored
}

export async function assembleAttachments(
  snapshot: Record<string, { content: string; timestamp: number }>,
  context: ToolUseContext,
  preserved: Message[],
  callSite: 'compact_full' | 'compact_partial',
  ledger: Array<[string, FileState]>,
  projection?: { userContext: Record<string, string> },
): Promise<AttachmentMessage[]> {
  const [files, asyncAgents] = await Promise.all([
    createPostCompactFileAttachments(snapshot, context, POST_COMPACT_MAX_FILES_TO_RESTORE, preserved, projection !== undefined),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])
  if (projection === undefined) restorePreservedReads(context, ledger, preserved)
  const attachments: AttachmentMessage[] = [...files, ...asyncAgents]
  const skills = createSkillAttachmentIfNeeded(context.agentId, context.options.commands)
  if (skills !== null) attachments.push(skills)
  const model = context.options.engineModel
  const deltas = [
    ...await getPlannedDeferredToolsAttachment(context, preserved, {
      callSite,
      hasPendingMcpServers: [...context.options.mcpClients, ...(context.getAppState?.().mcp?.clients ?? [])].some(client => client.type === 'pending'),
    }),
    ...getMcpInstructionsDeltaAttachment(context.options.mcpClients, context.options.tools, model, preserved),
  ]
  for (const delta of deltas) attachments.push(createAttachmentMessage(delta))
  if (!context.agentId) {
    for (const row of await getUserContextAttachment(preserved, projection?.userContext)) {
      attachments.push(createAttachmentMessage(row))
    }
  }
  return attachments
}
