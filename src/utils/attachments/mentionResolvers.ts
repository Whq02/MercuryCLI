import { readdir, stat } from 'fs/promises'
import { relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { createChildAbortController } from '../abortController.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { generateFileAttachment, mentionDeniedByRule, mentionPastCeiling } from './fileAttachments.js'
import { extractAgentMentions, extractAtMentionedFiles, extractMcpResourceMentions, parseAtMentionedFileLines } from './mentions.js'
import { isFileReadDenied } from './shared.js'
import type { Attachment } from './types.js'

export function processAgentMentions(input: string, agents: AgentDefinition[]): Attachment[] {
  return extractAgentMentions(input).flatMap(word => {
    const type = word.replace('agent-', '')
    const known = agents.find(agent => agent.agentType === type)
    return known ? [{ type: 'agent_mention' as const, agentType: known.agentType }] : []
  })
}

async function readMentionedResource(word: string, context: ToolUseContext, clients: ToolUseContext['options']['mcpClients']): Promise<Attachment[]> {
  try {
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
  } catch {
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
  } catch {
    return []
  }
}

const MENTION_READ_CEILING_MS = 10_000

async function readMention(path: string, range: ReturnType<typeof parseAtMentionedFileLines>, context: ToolUseContext, state: ReturnType<ToolUseContext['getAppState']>): Promise<Attachment[]> {
  const standing = await stat(path).catch(() => null)
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
  let ceiling: ReturnType<typeof setTimeout> | undefined
  try {
    const range = parseAtMentionedFileLines(word)
    const path = expandPath(range.filename)
    if ([range.filename, path].some(networkPath) || reading.signal.aborted) return []
    return await Promise.race([
      readMention(path, range, { ...context, abortController: reading }, state),
      new Promise<Attachment[]>(resolve => {
        ceiling = setTimeout(() => resolve([mentionPastCeiling(path, MENTION_READ_CEILING_MS / 1000)]), MENTION_READ_CEILING_MS)
        reading.signal.addEventListener('abort', () => resolve([]), { once: true })
      }),
    ])
  } catch (error) {
    logError(error)
    return []
  } finally {
    clearTimeout(ceiling)
    reading.abort()
  }
}

export async function processAtMentionedFiles(input: string, context: ToolUseContext): Promise<Attachment[]> {
  const words = extractAtMentionedFiles(input)
  if (!words.length) return []
  const state = context.getAppState()
  return (await Promise.all(words.map(word => fileMention(word, context, state)))).flat()
}
