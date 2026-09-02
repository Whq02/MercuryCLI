// Mention resolution — the context-coupled layer over the pure mentions
// parsers: @-file reads (with directory listings + line ranges), MCP resource
// fetches, agent-mention validation, and the IDE selection/opened-file
// producers.

import { readdir, stat } from 'fs/promises'
import { relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { getConnectedIdeName } from '../ide.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { generateFileAttachment } from './fileAttachments.js'
import {
  extractAgentMentions,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  parseAtMentionedFileLines,
} from './mentions.js'
import { getNestedMemoryAttachmentsForFile } from './nestedMemory.js'
import { isFileReadDenied } from './shared.js'
import type { Attachment } from './types.js'

export async function getSelectedLinesFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients)
  if (
    !ideName ||
    ideSelection?.lineStart === undefined ||
    !ideSelection.text ||
    !ideSelection.filePath
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  return [
    {
      type: 'selected_lines_in_ide',
      ideName,
      lineStart: ideSelection.lineStart,
      lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
      filename: ideSelection.filePath,
      content: ideSelection.text,
      displayPath: relative(getCwd(), ideSelection.filePath),
    },
  ]
}

export async function getOpenedFileFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  // Nested instruction files the opened file's directory chain pulls in.
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(
    ideSelection.filePath,
    toolUseContext,
    appState,
  )

  // Instruction context first, then the opened file itself.
  return [
    ...nestedMemoryAttachments,
    {
      type: 'opened_file_in_ide',
      filename: ideSelection.filePath,
    },
  ]
}

export async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async file => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)

        // Same law as the file tools' validateInput: a UNC-shaped path gets
        // ZERO filesystem calls from the resolver — stat/readdir on
        // \\server\share touches the network (SMB credential leak) before
        // any permission gate could run. The RAW spelling is what carries
        // the shape (expansion normalizes `//x` to `/x` on POSIX), so both
        // forms are tested. The mention stays plain text.
        if (
          filename.startsWith('\\\\') ||
          filename.startsWith('//') ||
          absoluteFilename.startsWith('\\\\') ||
          absoluteFilename.startsWith('//')
        ) {
          return null
        }

        if (
          isFileReadDenied(absoluteFilename, appState.toolPermissionContext)
        ) {
          return null
        }

        // Directories @-mention as listings, not file reads.
        try {
          const stats = await stat(absoluteFilename)
          if (stats.isDirectory()) {
            try {
              const entries = await readdir(absoluteFilename, {
                withFileTypes: true,
              })
              const MAX_DIR_ENTRIES = 1000
              const truncated = entries.length > MAX_DIR_ENTRIES
              const names = entries.slice(0, MAX_DIR_ENTRIES).map(e => e.name)
              if (truncated) {
                names.push(
                  `\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`,
                )
              }
              const stdout = names.join('\n')

              return {
                type: 'directory' as const,
                path: absoluteFilename,
                content: stdout,
                displayPath: relative(getCwd(), absoluteFilename),
              }
            } catch {
              return null
            }
          }
        } catch {
          // Unstattable ⇒ treat as a file path and let the read decide.
        }

        return await generateFileAttachment(
          absoluteFilename,
          toolUseContext,
          'at-mention',
          {
            offset: lineStart,
            limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined,
          },
        )
      } catch (error) {
        // A dropped @-mention must at least be visible in the logs — the
        // prompt otherwise submits without the file and nothing says so.
        logError(error)
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}

export function processAgentMentions(
  input: string,
  agents: AgentDefinition[],
): Attachment[] {
  const agentMentions = extractAgentMentions(input)
  if (agentMentions.length === 0) return []

  const results = agentMentions.map(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)

    if (!agentDef) {
      return null
    }


    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType,
    }
  })

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}

export async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) return []

  const mcpClients = toolUseContext.options.mcpClients || []

  const results = await Promise.all(
    resourceMentions.map(async mention => {
      try {
        const [serverName, ...uriParts] = mention.split(':')
        const uri = uriParts.join(':') // URIs may carry their own colons

        if (!serverName || !uri) {
          return null
        }

        // The serving MCP client, by server name.
        const client = mcpClients.find(c => c.name === serverName)
        if (!client || client.type !== 'connected') {
          return null
        }

        // The resource's own metadata rides in from the server's listing.
        const serverResources =
          toolUseContext.options.mcpResources?.[serverName] || []
        const resourceInfo = serverResources.find(r => r.uri === uri)
        if (!resourceInfo) {
          return null
        }

        try {
          const result = await client.client.readResource({
            uri,
          })


          return {
            type: 'mcp_resource' as const,
            server: serverName,
            uri,
            name: resourceInfo.name || uri,
            description: resourceInfo.description,
            content: result,
          }
        } catch (error) {
          logError(error)
          return null
        }
      } catch {
        return null
      }
    }),
  )

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  ) as Attachment[]
}
