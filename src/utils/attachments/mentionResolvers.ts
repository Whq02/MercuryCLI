import { readdir, stat } from 'fs/promises'
import { relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { generateFileAttachment } from './fileAttachments.js'
import { extractAgentMentions, extractAtMentionedFiles, extractMcpResourceMentions, parseAtMentionedFileLines } from './mentions.js'
import { isFileReadDenied } from './shared.js'
import type { Attachment } from './types.js'

export function processAgentMentions(input: string, agents: AgentDefinition[]): Attachment[] {
  return extractAgentMentions(input).flatMap(word => {
    const known = agents.find(agent => agent.agentType === word.replace('agent-', ''))
    return known ? [{ type: 'agent_mention' as const, agentType: known.agentType }] : []
  })
}

async function readMentionedResource(word: string, context: ToolUseContext): Promise<Attachment[]> {
  try {
    const colon = word.indexOf(':')
    if (colon < 1 || colon === word.length - 1) return []
    const server = word.slice(0, colon)
    const uri = word.slice(colon + 1)
    const connection = (context.options.mcpClients || []).find(client => client.name === server)
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
  return (await Promise.all(extractMcpResourceMentions(input).map(word => readMentionedResource(word, context)))).flat()
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

async function fileMention(word: string, context: ToolUseContext, state: ReturnType<ToolUseContext['getAppState']>): Promise<Attachment[]> {
  try {
    const range = parseAtMentionedFileLines(word)
    const path = expandPath(range.filename)
    if ([range.filename, path].some(networkPath) || isFileReadDenied(path, state.toolPermissionContext)) return []
    const isDirectory = await stat(path).then(info => info.isDirectory(), () => false)
    if (isDirectory) return directoryMention(path)
    const row = await generateFileAttachment(path, context, 'at-mention', {
      offset: range.lineStart,
      limit: range.lineStart && range.lineEnd ? range.lineEnd - range.lineStart + 1 : undefined,
    })
    return row ? [row] : []
  } catch (error) {
    logError(error)
    return []
  }
}

export async function processAtMentionedFiles(input: string, context: ToolUseContext): Promise<Attachment[]> {
  const words = extractAtMentionedFiles(input)
  if (!words.length) return []
  const state = context.getAppState()
  return (await Promise.all(words.map(word => fileMention(word, context, state)))).flat()
}
