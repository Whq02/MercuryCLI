import { closeSync, readSync } from 'node:fs'
import { parse, relative } from 'node:path'
import { getInvokedSkillsForAgent } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, AttachmentMessage, Message, UserMessage } from '../../../types/message.js'
import { getAgentRosterAttachment, queuedNoticeTaskIds } from '../../attachments/agentRoster.js'
import { getPlannedDeferredToolsAttachment, getMcpInstructionsDeltaAttachment } from '../../attachments/deltas.js'
import { generateFileAttachment } from '../../attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { isFileReadDenied } from '../../../utils/attachments/shared.js'
import { getUserContextAttachment } from '../../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../../utils/config/derived.js'
import { getCwd } from '../../../utils/cwd.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getDefaultFileReadingLimits } from '../../../utils/fileReadLimits.js'
import { isImageFilePath } from '../../../utils/imagePaste.js'
import { getCommandQueue } from '../../../utils/messageQueueManager.js'
import { MEMORY_TYPE_VALUES } from '../../../utils/memory/types.js'
import { expandPath } from '../../../utils/path.js'
import type { FileState } from '../../../utils/fileStateCache.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { openRegularFileSync } from '../../../utils/regularFile.js'
import { isPDFExtension } from '../../pdfUtils.js'
import { isInstructionFilePath } from '../../../services/instructions/engine.js'
import { roughTokenCountEstimation } from '../../tokenEstimation.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../../utils/toolResultStorage.js'
import { REPEATED_RESULT_TAG } from '../../../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB, MAX_LINES_TO_READ } from '../../../constants/tools/fileRead.js'
import { estimateContextTokens } from '../microCompact.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE, POST_COMPACT_MAX_TOKENS_PER_SKILL, POST_COMPACT_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD } from './limits.js'
import { type CompactionResult, buildPostCompactMessages } from './result.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'
import { isRecord } from '../../../utils/isRecord.js'

export function collectPreservedReadPaths(preserved: Message[], resultIds?: ReadonlySet<string>): Set<string> {
  const stubs = new Set<string>()
  const shown = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const text =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
                .map(item => item.text)
                .join('\n')
            : ''
      if (
        text.includes(FILE_UNCHANGED_STUB) ||
        text.startsWith(FOLDED_RESULT_KEY) ||
        text.startsWith(REPEATED_RESULT_TAG)
      ) {
        stubs.add(block.tool_use_id)
      } else if (
        resultIds !== undefined &&
        resultIds.has(block.tool_use_id) &&
        block.is_error !== true &&
        text !== '' &&
        !text.startsWith(PERSISTED_OUTPUT_TAG) &&
        !text.startsWith(TOOL_RESULT_CLEARED_MESSAGE)
      ) {
        shown.add(block.tool_use_id)
      }
    }
  }
  const paths = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== FILE_READ_TOOL_NAME) continue
      if (stubs.has(block.id)) continue
      if (resultIds !== undefined && !shown.has(block.id)) continue
      if (isRecord(block.input) && typeof block.input.file_path === 'string') {
        paths.add(expandPath(block.input.file_path))
      }
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

function projectedFileAttachment(
  path: string,
  state: { content: string; timestamp: number },
  toolUseContext: ToolUseContext,
): Attachment | null {
  if (isRemotePath(path)) return null
  if (isFileReadDenied(path, toolUseContext.getAppState().toolPermissionContext)) return null
  const displayPath = relative(getCwd(), path)
  const fallback = (): Attachment => {
    const lines = state.content.split('\n')
    return {
      type: 'file',
      filename: path,
      displayPath: path,
      content: { type: 'text', file: { filePath: path, content: state.content, numLines: lines.length, startLine: 1, totalLines: lines.length } },
    }
  }
  if (isImageFilePath(path) || isPDFExtension(parse(path).ext.toLowerCase())) return fallback()
  let opened: ReturnType<typeof openRegularFileSync>
  try {
    opened = openRegularFileSync(path)
  } catch (error) {
    passedOver(error)
    return fallback()
  }
  const { fd, stats } = opened
  try {
    if (!stats.isFile()) return null
    const limits = getDefaultFileReadingLimits()
    if (stats.size > limits.maxSizeBytes) return { type: 'compact_file_reference', filename: path, displayPath }
    const maxBytes = Math.min(stats.size, limits.maxTokens * 4 + 4_096)
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = maxBytes > 0 ? readSync(fd, buffer, 0, maxBytes, 0) : 0
    const slice = buffer.subarray(0, bytesRead)
    if (slice.includes(0)) return fallback()
    const raw = slice.toString('utf8')
    const allLines = raw.split('\n')
    const shown = allLines.slice(0, MAX_LINES_TO_READ)
    const content = shown.join('\n')
    if (roughTokenCountEstimation(content) > limits.maxTokens) return { type: 'compact_file_reference', filename: path, displayPath }
    return {
      type: 'file',
      filename: path,
      displayPath,
      content: { type: 'text', file: { filePath: path, content, numLines: shown.length, startLine: 1, totalLines: allLines.length } },
    }
  } catch (error) {
    passedOver(error)
    return fallback()
  } finally {
    closeSync(fd)
  }
}

export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
  project = false,
): Promise<AttachmentMessage[]> {
  const preservedReads = collectPreservedReadPaths(preservedMessages)
  const memoryPaths = new Set<string>()
  for (const memoryType of MEMORY_TYPE_VALUES) {
    try {
      memoryPaths.add(expandPath(getMemoryPath(memoryType)))
    } catch (error) {
      passedOver(error)
    }
  }
  const candidates = Object.entries(readFileState)
    .filter(([path]) => {
      const expanded = expandPath(path)
      if (isInstructionFilePath(expanded) || memoryPaths.has(expanded)) return false
      if (preservedReads.has(expanded)) return false
      return true
    })
    .sort(([, a], [, b]) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)

  const rawAttachments: Array<Attachment | null> = project
    ? candidates.map(([path, state]) => projectedFileAttachment(path, state, toolUseContext))
    : await Promise.all(
        candidates.map(([path]) =>
          generateFileAttachment(path, toolUseContext, 'compact', { limit: MAX_LINES_TO_READ }).catch(
            passedOverAs(null),
          ),
        ),
      )

  const kept: AttachmentMessage[] = []
  let totalTokens = 0
  for (const raw of rawAttachments) {
    if (raw === null) continue
    const fitted = fitFileAttachmentToTokenCeiling(raw, POST_COMPACT_MAX_TOKENS_PER_FILE)
    const message = createAttachmentMessage(fitted)
    const tokens = roughTokenCountEstimation(JSON.stringify(message))
    if (totalTokens + tokens <= POST_COMPACT_TOKEN_BUDGET) {
      kept.push(message)
      totalTokens += tokens
    }
  }
  return kept
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

const SKILL_TRUNCATION_MARKER =
  '\n\n[Skill content truncated for compaction — Read the skill path above for the full text.]'

export function createSkillAttachmentIfNeeded(
  agentId?: string,
  catalogue?: ReadonlyArray<{ name: string }>,
): AttachmentMessage | null {
  const invoked = getInvokedSkillsForAgent(agentId)
  if (invoked.size === 0) return null
  const allowedNames = catalogue !== undefined ? new Set(catalogue.map(item => item.name)) : null
  const entries = Array.from(invoked.values()).filter(skill => {
    if (allowedNames !== null && !allowedNames.has(skill.skillName)) {
      logForDebugging(`compact: dropping invoked skill "${skill.skillName}" no longer in catalogue`)
      return false
    }
    return true
  })
  if (entries.length === 0) return null
  entries.sort((a, b) => b.invokedAt - a.invokedAt)

  const maxChars = POST_COMPACT_MAX_TOKENS_PER_SKILL * 4
  const skills: Array<{ name: string; path: string; content: string }> = []
  let totalTokens = 0
  for (const skill of entries) {
    const content =
      skill.content.length > maxChars
        ? skill.content.slice(0, Math.max(0, maxChars - SKILL_TRUNCATION_MARKER.length)) + SKILL_TRUNCATION_MARKER
        : skill.content
    const tokens = roughTokenCountEstimation(content)
    if (totalTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) continue
    totalTokens += tokens
    skills.push({ name: skill.skillName, path: skill.skillPath, content })
  }
  if (skills.length === 0) return null
  return createAttachmentMessage({ type: 'invoked_skills', skills })
}

export async function createAsyncAgentAttachmentsIfNeeded(context: ToolUseContext): Promise<AttachmentMessage[]> {
  const appState = context.getAppState()
  const attachments = getAgentRosterAttachment({
    tasks: appState.tasks,
    agentNameRegistry: appState.agentNameRegistry,
    excludeAgentId: context.agentId,
    queuedNoticeIds: queuedNoticeTaskIds(getCommandQueue()),
  })
  return attachments.map(attachment => createAttachmentMessage(attachment))
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

export function restoreReadState(
  context: ToolUseContext,
  ledger: Array<[string, FileState]>,
  nestedMemoryPaths?: readonly string[],
): void {
  context.readFileState.clear()
  for (const [path, state] of ledger) context.readFileState.set(path, state)
  if (nestedMemoryPaths !== undefined && context.loadedNestedMemoryPaths !== undefined) {
    context.loadedNestedMemoryPaths.clear()
    for (const path of nestedMemoryPaths) context.loadedNestedMemoryPaths.add(path)
  }
}

export async function assembleAttachments(
  snapshot: Record<string, { content: string; timestamp: number }>,
  context: ToolUseContext,
  preserved: Message[],
  callSite: 'compact_full' | 'compact_partial',
  ledger: Array<[string, FileState]>,
  projection?: { userContext: Record<string, string> },
  restoreFiles = true,
): Promise<AttachmentMessage[]> {
  const [fileAttachments, agentAttachments] = await Promise.all([
    restoreFiles
      ? createPostCompactFileAttachments(
          snapshot,
          context,
          POST_COMPACT_MAX_FILES_TO_RESTORE,
          preserved,
          projection !== undefined,
        )
      : Promise.resolve<AttachmentMessage[]>([]),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])

  if (projection === undefined) {
    restorePreservedReads(context, ledger, preserved)
  }

  const attachments: AttachmentMessage[] = [...fileAttachments, ...agentAttachments]

  const skillAttachment = createSkillAttachmentIfNeeded(context.agentId, context.options.commands)
  if (skillAttachment !== null) {
    attachments.push(skillAttachment)
  }

  const appState = context.getAppState()
  const mcpClients = context.options.mcpClients ?? []
  const appMcpClients = appState.mcp?.clients ?? []
  const hasPendingMcpServers =
    mcpClients.some(client => client.type === 'pending') ||
    appMcpClients.some(client => client.type === 'pending')

  const deferredToolsAttachments = await getPlannedDeferredToolsAttachment(context, preserved, {
    callSite,
    querySource: context.options.querySource,
    hasPendingMcpServers,
  })
  for (const attachment of deferredToolsAttachments) {
    attachments.push(createAttachmentMessage(attachment))
  }

  const mcpDeltaAttachments = getMcpInstructionsDeltaAttachment(
    mcpClients,
    context.options.tools,
    context.options.engineModel,
    preserved,
  )
  for (const attachment of mcpDeltaAttachments) {
    attachments.push(createAttachmentMessage(attachment))
  }

  if (!context.agentId) {
    const userContextAttachments = await getUserContextAttachment(preserved, projection?.userContext)
    for (const attachment of userContextAttachments) {
      attachments.push(createAttachmentMessage(attachment))
    }
  }

  return attachments
}
