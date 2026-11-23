import { readdir, stat } from 'fs/promises'
import { relative } from 'path'
import { getCwd } from 'src/platform/files/cwd.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { createChildAbortController } from '../../platform/async/abortController.js'
import { logError } from '../../platform/logs/errorLog.js'
import { expandPath } from '../../platform/files/path.js'
import { generateFileAttachment, mentionDeniedByRule, mentionPastCeiling, mentionReadFailed } from './fileAttachments.js'
import { extractAgentMentions, extractAtMentionedFiles, extractMcpResourceMentions, parseAtMentionedFileLines } from '../attachment-shapes/mentions.js'
import { isFileReadDenied } from '../attachment-shapes/fileReadDenied.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'

export function processAgentMentions(input: string, agents: AgentDefinition[]): Attachment[] {
  return extractAgentMentions(input).flatMap(word => {
    const type = word.replace('agent-', '')
    const known = agents.find(agent => agent.agentType === type)
    return known ? [{ type: 'agent_mention' as const, agentType: known.agentType }] : []
  })
}

async function readMentionedResource(word: string, context: ToolUseContext, clients: ToolUseContext['options']['mcpClients']): Promise<Attachment[]> {
  const colon = word.indexOf(':')
  if (colon < 1 || colon === word.length - 1) return []
  const server = word.slice(0, colon)
  const uri = word.slice(colon + 1)
  const connection = clients.find(client => client.name === server)
  if (connection?.type !== 'connected') return []
  const info = (context.options.mcpResources?.[server] || []).find(resource => resource.uri === uri)
  if (!info) return []
  try {
    const content = await connection.client.readResource({ uri })
    return [{ type: 'mcp_resource', server, uri, name: info.name || uri, description: info.description, content }]
  } catch (error) {
    logError(error)
    return []
  }
}

export async function processMcpResourceAttachments(input: string, context: ToolUseContext): Promise<Attachment[]> {
  const mentions = extractMcpResourceMentions(input)
  if (!mentions.length) return []
  const clients = context.options.mcpClients || []
  return (await Promise.all(mentions.map(word => readMentionedResource(word, context, clients)))).flat()
}

const networkPath = (path: string): boolean => path.startsWith('\\\\') || path.startsWith('//')

async function directoryMention(path: string): Promise<Attachment[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const lines = entries.slice(0, 1000).map(entry => entry.name)
    const remaining = entries.length - lines.length
    if (remaining > 0) lines.push(`… and ${remaining} more entries`)
    return [{ type: 'directory', path, content: lines.join('\n'), displayPath: relative(getCwd(), path) }]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return [mentionReadFailed(path, error)]
  }
}

const MENTION_READ_CEILING_MS = 10_000

async function readMention(path: string, range: ReturnType<typeof parseAtMentionedFileLines>, context: ToolUseContext, state: ReturnType<ToolUseContext['getAppState']>): Promise<Attachment[]> {
  const standing = await stat(path).catch(passedOverAs(null))
  if (isFileReadDenied(path, state.toolPermissionContext)) {
    const denied = standing === null ? null : mentionDeniedByRule(path, state.toolPermissionContext)
    return denied ? [denied] : []
  }
  if (standing?.isDirectory()) return directoryMention(path)
  const row = await generateFileAttachment(path, context, 'at-mention', {
    offset: range.lineStart,
    limit: range.lineStart && range.lineEnd ? range.lineEnd - range.lineStart + 1 : undefined,
  })
  return row ? [row] : []
}

async function fileMention(word: string, context: ToolUseContext, state: ReturnType<ToolUseContext['getAppState']>): Promise<Attachment[]> {
  const reading = createChildAbortController(context.abortController)
  try {
    const range = parseAtMentionedFileLines(word)
    const path = expandPath(range.filename)
    if ([range.filename, path].some(networkPath) || reading.signal.aborted) return []
    return await withDeadline(
      readMention(path, range, { ...context, abortController: reading }, state),
      MENTION_READ_CEILING_MS,
      () => [mentionPastCeiling(path, MENTION_READ_CEILING_MS / 1000)],
      { signal: reading.signal, onAbort: () => [] },
    )
  } catch (error) {
    logError(error)
    return []
  } finally {
    reading.abort()
  }
}

export async function processAtMentionedFiles(input: string, context: ToolUseContext): Promise<Attachment[]> {
  const words = extractAtMentionedFiles(input)
  if (!words.length) return []
  const state = context.getAppState()
  return (await Promise.all(words.map(word => fileMention(word, context, state)))).flat()
}
