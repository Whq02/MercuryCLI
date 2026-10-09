
import { boundHookContext } from '../hooks/contextBound.js'
import type { ContentBlockParam, TextBlockParam } from '../../types/wire.js'

import { BashTool } from 'src/tools/BashTool/BashTool.js'
import {
  FILE_READ_TOOL_NAME,
  MAX_LINES_TO_READ,
} from 'src/tools/FileReadTool/prompt.js'
import { DiagnosticTrackingService } from '../../services/diagnosticTracking.js'
import { type AnyObject, type Tool } from '../../Tool.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
} from '../../tools/FileReadTool/FileReadTool.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../../tools/ResumeAgentTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import type { MessageOrigin, UserMessage } from '../../types/message.js'
import { type Attachment, memoryHeader } from '../attachments.js'
import { DEFERRED_TOOLS_ANNOUNCEMENT_HEAD } from '../attachments/deltas.js'
import { quote } from '../bash/shellQuote.js'
import { formatFileSize, formatNumber } from '../format.js'
import { jsonStringify } from '../slowOperations.js'
import { isTaskToolsEnabled } from '../tasks.js'
import { operatorMessagesBlockText } from '../../services/compact/operatorMessages.js'
import { createUserMessage } from './factories.js'
import { isAdvisorOrigin } from './noticeRows.js'
import {
  wrapCommandText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
} from './text.js'


export function normalizeAttachmentForAPI(
  attachment: Attachment,
): UserMessage[] {
  if (attachment.capsuleReceipt) return []
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- an unknown type projects to nothing
  switch (attachment.type) {
    case 'directory': {
      return wrapMessagesInSystemReminder([
        createToolUseMessage(BashTool.name, {
          command: `ls ${quote([attachment.path])}`,
          description: `Lists files in ${attachment.path}`,
        }),
        createToolResultMessage(BashTool, {
          stdout: attachment.content,
          stderr: '',
          interrupted: false,
        }),
      ])
    }
    case 'edited_text_file':
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `${attachment.filename} changed outside this conversation — the user or a linter edited it. The change is intentional: work with it, and never revert it unless the user asks. Do not mention it to the user; they already know. The relevant changes (with line numbers):\n${attachment.snippet}`,
          isMeta: true,
        }),
      ])
    case 'file': {
      const fileContent = attachment.content as FileReadToolOutput
      switch (fileContent.type) {
        case 'image': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'text': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
            ...(attachment.truncated
              ? [
                  createUserMessage({
                    content: `${attachment.filename} was too large — only its first ${MAX_LINES_TO_READ} lines are shown above. Read further with ${FileReadTool.name} when you need more; do not mention the truncation to the user.`,
                    isMeta: true,
                  }),
                ]
              : []),
          ])
        }
        case 'notebook': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'pdf': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
      }
      break
    }
    case 'compact_file_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `${attachment.filename} was read before the conversation was summarized, and its contents are too large to carry across. Re-read it with ${FileReadTool.name} when you need it.`,
          isMeta: true,
        }),
      ])
    }
    case 'pdf_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            `PDF: ${attachment.filename} (${attachment.pageCount} pages, ${formatFileSize(attachment.fileSize)}) — too large to read in one pass. ` +
            `Read it through ${FILE_READ_TOOL_NAME} with the pages parameter, in ranges (e.g. pages: "1-5"); a call WITHOUT pages will fail on this file. ` +
            `Start with the first few pages to learn the structure, then pull more as needed — at most 20 pages per request.`,
          isMeta: true,
        }),
      ])
    }
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return []
      }

      const skillsContent = attachment.skills
        .map(
          skill =>
            `### ${skill.name} (${skill.path})\n\n${skill.content}`,
        )
        .join('\n\n---\n\n')

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `These skills were invoked earlier in the session and still bind — keep following them:\n\n${skillsContent}`,
          isMeta: true,
        }),
      ])
    }
    case 'contract_reminder': {
      const ackLine = attachment.ackOwed
        ? `\n\nIt awaits YOUR acknowledgment: restate it in your own words through the ${'`'}contract${'`'} tool ({ action: "acknowledge", restatement }) — the restatement is what makes it stick.`
        : ''
      const historyLine = attachment.amendments > 0 ? ` (${attachment.amendments} superseded text${attachment.amendments === 1 ? '' : 's'} in its history)` : ''
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `This session runs under a CONTRACT — its work agreement, status ${attachment.status}${historyLine}. It is ADVISORY: it encourages your work and never blocks anything; hold yourself to it, check in through the ${'`'}contract${'`'} tool when unsure, and propose an amendment there when a clause does not survive contact with the code. NEVER mention this reminder to the user.${ackLine}\n\nThe agreement:\n\n${attachment.text}`,
          isMeta: true,
        }),
      ])
    }
    case 'task_reminder': {
      if (!isTaskToolsEnabled()) {
        return []
      }
      const taskItems = attachment.content
        .map(task => `#${task.id}. [${task.status}] ${task.subject}`)
        .join('\n')

      let message = `The task tools haven't been touched in a while. If the current work would benefit from tracked progress, use ${TASK_CREATE_TOOL_NAME} to add tasks and ${TASK_UPDATE_TOOL_NAME} to move their status (in_progress on start, completed on finish) — and clean the list up if it has gone stale. Relevant work only; ignore this if it doesn't apply, and NEVER mention this reminder to the user.\n`
      if (taskItems.length > 0) {
        message += `\n\nThe current tasks:\n\n${taskItems}`
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: message,
          isMeta: true,
        }),
      ])
    }
    case 'nested_memory': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Instruction file ${attachment.content.path} (it governs its folder):\n\n${attachment.content.content}`,
          isMeta: true,
        }),
      ])
    }
    case 'relevant_memories': {
      return wrapMessagesInSystemReminder(
        attachment.memories.map(m => {
          const header = m.header ?? memoryHeader(m.path, m.mtimeMs)
          return createUserMessage({
            content: `${header}\n\n${m.content}`,
            isMeta: true,
          })
        }),
      )
    }
    case 'dynamic_skill': {
      return []
    }
    case 'skill_listing': {
      const parts: string[] = []
      if (attachment.content) {
        parts.push(
          `The skills this session offers, run by name through the Skill tool:\n\n${attachment.content}`,
        )
      }
      const truncation = attachment.truncation
      if (truncation && (truncation.nameOnly > 0 || truncation.withheld > 0)) {
        const bits: string[] = []
        if (truncation.nameOnly > 0) {
          bits.push(
            `${truncation.nameOnly} of the entries above list name-only (the catalogue budget was reached); each skill's full description is available on invocation`,
          )
        }
        if (truncation.withheld > 0) {
          bits.push(`${truncation.withheld} further skill name(s) were withheld entirely`)
        }
        parts.push(`Note: ${bits.join('; ')}.`)
      }
      if ((attachment.removedNames?.length ?? 0) > 0) {
        parts.push(
          `The following skills are no longer available (dialled off or removed). Do not invoke them — the Skill tool will refuse:\n${attachment.removedNames!.join('\n')}`,
        )
      }
      if (parts.length === 0) {
        return []
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: parts.join('\n\n'),
          isMeta: true,
        }),
      ])
    }
    case 'queued_command': {
      const origin: MessageOrigin | undefined =
        attachment.origin ??
        (attachment.commandMode === 'task-notification'
          ? { kind: 'task-notification' }
          : undefined)

      const metaProp =
        (origin !== undefined && !isAdvisorOrigin(origin)) || attachment.isMeta
          ? ({ isMeta: true } as const)
          : {}

      if (Array.isArray(attachment.prompt)) {
        const textContent = attachment.prompt
          .filter((block): block is TextBlockParam => block.type === 'text')
          .map(block => block.text)
          .join('\n')

        const imageBlocks = attachment.prompt.filter(
          block => block.type === 'image',
        )

        const content: ContentBlockParam[] = [
          {
            type: 'text',
            text: wrapCommandText(textContent, origin),
          },
          ...imageBlocks,
        ]

        return wrapMessagesInSystemReminder([
          createUserMessage({
            content,
            ...metaProp,
            origin,
            uuid: attachment.source_uuid,
          }),
        ])
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: wrapCommandText(String(attachment.prompt), origin),
          ...metaProp,
          origin,
          uuid: attachment.source_uuid,
        }),
      ])
    }
    case 'diagnostics': {
      if (attachment.files.length === 0) return []

      const diagnosticSummary =
        DiagnosticTrackingService.formatDiagnosticsSummary(attachment.files)

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `<new-diagnostics>New diagnostics from the language server:\n\n${diagnosticSummary}</new-diagnostics>`,
          isMeta: true,
        }),
      ])
    }
    case 'mode_pack': {
      if (attachment.mode !== 'apollo') return []
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.text, isMeta: true }),
      ])
    }
    case 'mode_pack_exit': {
      if (attachment.mode !== 'apollo') return []
      const label = 'Apollo mode'
      const why = attachment.reason !== undefined ? ` What ended it: ${attachment.reason}.` : ''
      const content = `## Exited ${label}

${label} is off: its instructions above no longer apply, and the session's standing instructions govern again.${why}`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'context_capsule': {
      if (attachment.sections) return projectCapsuleSections(attachment)
      const content = `${attachment.markdown}

These are evidence-ranked STARTING POINTS (exact task names > active work > import adjacency > current changes), not a complete file list — dereference to read, verify before relying, and explore beyond them when the task needs it.
capsule-digest:${attachment.digest}${attachment.delta ? `\nWorking-set delta vs the previous capsule: ${attachment.delta}` : ''}`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'critical_system_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.content, isMeta: true }),
      ])
    }
    case 'mcp_resource': {
      const transformedBlocks: ContentBlockParam[] = []

      for (const item of attachment.content?.contents ?? []) {
        if (item && typeof item === 'object') {
          if ('text' in item && typeof item.text === 'string') {
            transformedBlocks.push(
              {
                type: 'text',
                text: 'Full contents of resource:',
              },
              {
                type: 'text',
                text: item.text,
              },
              {
                type: 'text',
                text: 'These are the complete contents — re-read the resource only if you have reason to believe it changed.',
              },
            )
          } else if ('blob' in item) {
            const mimeType =
              'mimeType' in item
                ? String(item.mimeType)
                : 'application/octet-stream'
            transformedBlocks.push({
              type: 'text',
              text: `[Binary content: ${mimeType}]`,
            })
          }
        }
      }

      if (transformedBlocks.length === 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">the server returned nothing readable for this resource</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: transformedBlocks,
          isMeta: true,
        }),
      ])
    }
    case 'agent_mention': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user's message names the agent "${attachment.agentType}" — invoke that agent for this work, passing it the context it needs.`,
          isMeta: true,
        }),
      ])
    }
    case 'agent_roster': {
      if (attachment.rows.length === 0) return []
      const lines = attachment.rows.map(row => {
        const bits: string[] = [`${row.taskType} "${row.name}" [${row.taskId}]: ${row.status}`]
        if (row.wait) bits.push(row.wait)
        if (row.phase) bits.push(`phase: ${row.phase}`)
        if (row.agents && row.agents.length > 0) {
          bits.push(`agents: ${row.agents.map(agent => `${agent.label} — ${agent.state}`).join(', ')}`)
        }
        if (row.description && row.description !== row.name) bits.push(`asked: ${row.description}`)
        if (row.error) bits.push(`error: ${row.error}`)
        if (row.owed) bits.push(`owed: ${row.owed}`)
        bits.push(
          row.address !== null
            ? row.status === 'running'
              ? `reach it: ${SEND_MESSAGE_TOOL_NAME} to "${row.address}"`
              : `resume it: ${RESUME_AGENT_TOOL_NAME} to "${row.address}"`
            : `reach it: ${TASK_STOP_TOOL_NAME} by its id`,
        )
        if (row.outputFilePath) bits.push(`output: ${row.outputFilePath}`)
        return `- ${bits.join(' · ')}`
      })
      const states = new Map<string, number>()
      for (const row of attachment.rows) states.set(row.status, (states.get(row.status) ?? 0) + 1)
      const countLine = `${attachment.rows.length} agent${attachment.rows.length === 1 ? '' : 's'}: ${[...states.entries()].map(([status, n]) => `${n} ${status}`).join(' · ')}`
      const text = [
        'Agents in flight at the context turnover — every agent this session is running or owes a result from, one line each (kind "name" [id]: status · what it was asked · what is owed · how to reach it · output file):',
        countLine,
        lines.join('\n'),
        `A running agent is never re-spawned — its completion reaches you as a task notification on its own. A result that is owed is collected from that notification or from the output file, never re-derived. ${SEND_MESSAGE_TOOL_NAME} reaches a running crewmate and ${RESUME_AGENT_TOOL_NAME} gives any one a new turn, by the id or name shown; a task's output is read from the output file shown with ${FILE_READ_TOOL_NAME}; ${TASK_STOP_TOOL_NAME} stops one.`,
      ].join('\n')
      return [createUserMessage({ content: wrapInSystemReminder(text), isMeta: true })]
    }
    case 'budget_usd':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Budget \u2014 spent $${attachment.used} of $${attachment.total} \u00b7 $${attachment.remaining} left`,
          ),
          isMeta: true,
        }),
      ]
    case 'usage_limit_notice':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            (require('../../services/providers/limitWarning.js') as typeof import('../../services/providers/limitWarning.js')).usageWarningNoticeText(attachment.text, attachment.pct),
          ),
          isMeta: true,
        }),
      ]
    case 'output_token_usage': {
      const turnText =
        attachment.budget !== null
          ? `${formatNumber(attachment.turn)} / ${formatNumber(attachment.budget)}`
          : formatNumber(attachment.turn)
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Output tokens \u2014 turn: ${turnText} \u00b7 session: ${formatNumber(attachment.session)}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook': {
      if (attachment.outcome === 'context') {
        return [createUserMessage({ content: wrapInSystemReminder(`hook ${attachment.name} (${attachment.event}): ${boundHookContext(attachment.words, `${attachment.name}-context`).text}`), isMeta: true })]
      }
      if (attachment.outcome === 'block' && attachment.event === 'tool.after') {
        return [createUserMessage({ content: wrapInSystemReminder(`hook ${attachment.name} objected to this ${attachment.event} call: ${boundHookContext(attachment.words, `${attachment.name}-block`).text}`), isMeta: true })]
      }
      return []
    }
    case 'context_efficiency': {
      return []
    }
    case 'date_change': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The local date is now ${attachment.newDate}; the session context above still names the earlier one.`,
          isMeta: true,
        }),
      ])
    }
    case 'user_context': {
      return [createUserMessage({ content: attachment.body, isMeta: true })]
    }
    case 'loop_stopped':
      return [createUserMessage({ content: wrapInSystemReminder(attachment.message), isMeta: true })]
    case 'compact_operator_messages': {
      if (attachment.messages.length === 0) return []
      return [createUserMessage({ content: operatorMessagesBlockText(attachment), isMeta: true })]
    }
    case 'held_tools':
      return wrapMessagesInSystemReminder([createUserMessage({ content: attachment.body, isMeta: true })])
    case 'deferred_tools_delta': {
      if (attachment.body !== undefined) return wrapMessagesInSystemReminder([createUserMessage({ content: attachment.body, isMeta: true })])
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        parts.push(
          `${DEFERRED_TOOLS_ANNOUNCEMENT_HEAD}\n${attachment.addedLines.join('\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following deferred tools are no longer available in this session (their server disconnected or the operator turned them off). Do not search for them — ToolSearch will return no match:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'mcp_instructions_delta': {
      const parts: string[] = []
      if (attachment.addedBlocks.length > 0) {
        parts.push(
          `# MCP server instructions\n\nEach server below says how its tools and resources are used:\n\n${attachment.addedBlocks.join('\n\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `MCP servers gone from this session; their instructions above no longer hold:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'run_protocol_delta':
      return wrapMessagesInSystemReminder([createUserMessage({ content: attachment.body, isMeta: true })])
    case 'harness_map_delta': {
      const parts: string[] = []
      if (attachment.added.length > 0) {
        parts.push(
          `Mercury harness update — the following surfaces just became AVAILABLE in this session:\n${attachment.added.join('\n')}`,
        )
      }
      if (attachment.removed.length > 0) {
        parts.push(
          `Mercury harness update — the following surfaces are no longer available (their harness-map lines no longer apply):\n${attachment.removed.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'verify_plan_reminder': {
      return []
    }
    case 'already_read_file':
    case 'command_permissions':
    case 'edited_image_file':
    case 'structured_output':
    case 'bypassed_ask':
      return []
    case 'bound_prefix':
      return []
    case 'dead_thinking':
    case 'images_left_out':
      return []
  }

  return []
}

function createToolResultMessage<Output>(
  tool: Tool<AnyObject, Output>,
  toolUseResult: Output,
): UserMessage {
  try {
    const result = tool.mapToolResultToToolResultBlockParam(toolUseResult, '1')

    if (
      Array.isArray(result.content) &&
      result.content.some(block => block.type === 'image')
    ) {
      return createUserMessage({
        content: result.content as ContentBlockParam[],
        isMeta: true,
      })
    }

    const contentStr =
      typeof result.content === 'string'
        ? result.content
        : jsonStringify(result.content)
    return createUserMessage({
      content: `${tool.name} returned:\n${contentStr}`,
      isMeta: true,
    })
  } catch {
    return createUserMessage({
      content: `${tool.name} returned an error`,
      isMeta: true,
    })
  }
}

function createToolUseMessage(
  toolName: string,
  input: { [key: string]: string | number },
): UserMessage {
  return createUserMessage({
    content: `Mercury ran ${toolName} with ${jsonStringify(input)}`,
    isMeta: true,
  })
}

function projectCapsuleSections(attachment: Extract<Attachment, { type: 'context_capsule' }>): UserMessage[] {
  const content: ContentBlockParam[] = []
  const text = (value: string): void => {
    const prior = content.at(-1)
    if (prior?.type === 'text') prior.text += value
    else content.push({ type: 'text', text: value })
  }
  const safe = (value: string): string => value.replace(/<(\/?)system-reminder/g, '<\u200b$1system-reminder')
  text('<system-reminder>\n')
  text(safe(attachment.markdown || '# Working set'))
  if (attachment.markdown) text('\n\nThese are evidence-ranked STARTING POINTS (exact task names > active work > import adjacency > current changes), not a complete file list — dereference to read, verify before relying, and explore beyond them when the task needs it.')
  if (attachment.workingSet?.length) {
    text('\n\n' + attachment.workingSet.map(item => safe(`- ${item.ref} — ${item.reason}`)).join('\n'))
  }
  for (const section of attachment.sections ?? []) {
    text(`\n\n## ${safe(section.name)}`)
    for (const block of section.content) {
      if (block.type === 'text') text(`\n\n${safe(block.text)}`)
      else content.push(block)
    }
  }
  text(`\n\ncapsule-digest:${safe(attachment.digest)}`)
  if (attachment.delta) text(`\nWorking-set delta vs the previous capsule: ${safe(attachment.delta)}`)
  text('\n</system-reminder>')
  return [createUserMessage({ content, isMeta: true })]
}
