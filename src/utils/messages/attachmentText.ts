
import { boundHookContext, boundSeamContext } from '../hooks/contextBound.js'
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
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import type { MessageOrigin, UserMessage } from '../../types/message.js'
import { isCrewEnabled } from '../crewEnabled.js'
import { type Attachment, memoryHeader } from '../attachments.js'
import { stoppedContinuationMessage } from '../attachments/stoppedContinuation.js'
import { isCrewMessagesAttachment } from '../attachments/types.js'
import { formatCrewmateMessages } from '../../services/crew/liveMessages.js'
import { quote } from '../bash/shellQuote.js'
import { formatFileSize, formatNumber } from '../format.js'
import { logMCPDebug } from '../log.js'
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


function getAutoModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
}): UserMessage[] {
  if (attachment.reminderType === 'sparse') {
    return getAutoModeSparseInstructions()
  }
  return getAutoModeFullInstructions()
}

function getAutoModeFullInstructions(): UserMessage[] {
  const content = `## Flow Active

Flow is on: the user chose continuous, autonomous execution. That means:

1. **Execute now** — start implementing immediately; on low-risk work, a reasonable assumption beats a pause.
2. **Interrupt rarely** — routine decisions are yours to make, not questions to ask.
3. **Act over plan** — plan only when the user explicitly asks for it; in doubt, start coding.
4. **Take corrections in stride** — the user may steer or redirect at any point; that is normal input, not a fault signal.
5. **Destructive actions stay gated** — flow is not a license to destroy. Deleting data or touching shared/production systems still needs the user's explicit confirmation: ask and wait, or take a safer route.
6. **Nothing leaves without direction** — post to chat platforms or work tickets only when the user directed it, and never share a secret (credentials, internal documents) unless the user explicitly authorized that specific secret to that specific destination.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getAutoModeSparseInstructions(): UserMessage[] {
  const content = `Flow is still on (full instructions earlier in this conversation). Execute autonomously, interrupt rarely, act over plan.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function normalizeAttachmentForAPI(
  attachment: Attachment,
): UserMessage[] {
  if (attachment.capsuleReceipt) return []
  if (isCrewEnabled()) {
    if (isCrewMessagesAttachment(attachment)) {
      const boundedMessages = attachment.messages.map(message => ({
        ...message,
        text: boundSeamContext(message.text, `crewmate-${message.from}`).text,
      }))
      return [
        createUserMessage({
          content: formatCrewmateMessages(boundedMessages),
          isMeta: true,
        }),
      ]
    }
    if (attachment.type === 'crew_context') {
      return [
        createUserMessage({
          content: `<system-reminder>
# Crew Coordination

You are a crewmate in crew "${attachment.crewName}".

**Your Identity:**
- Name: ${attachment.agentName}

**Crew Resources:**
- Crew config: ${attachment.crewConfigPath}
- Task list: ${attachment.taskListPath}

**Crew Leader:** the lead's name is "crew-lead" — updates and completion notifications go to them.

The crew config lists your crewmates' names. Check the task list periodically; create tasks when work should be divided, and mark yours resolved when complete.

**IMPORTANT:** crewmates are addressed by NAME ("crew-lead", "analyzer", "researcher"), never by UUID:

\`\`\`json
{
  "to": "crew-lead",
  "message": "Your message here",
  "summary": "Brief 5-10 word preview"
}
\`\`\`
</system-reminder>`,
          isMeta: true,
        }),
      ]
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- crew_messages/crew_context are handled above the switch (their literals stay inside the isCrewEnabled() guard); retired types fall through to the legacy sink below
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
            `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`,
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
          content: `Contents of ${attachment.content.path}:\n\n${attachment.content.content}`,
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
          `The following skills are available for use with the Skill tool:\n\n${attachment.content}`,
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
          content: `<new-diagnostics>The following new diagnostic issues were detected:\n\n${diagnosticSummary}</new-diagnostics>`,
          isMeta: true,
        }),
      ])
    }
    case 'auto_mode': {
      return getAutoModeInstructions(attachment)
    }
    case 'auto_mode_exit': {
      const content = `## Exited Flow

Flow is off — the user likely wants a more interactive pace again. Where the approach is ambiguous, ask a clarifying question rather than assuming.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
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
    case 'repo_surface_map': {
      const content = `This repository has no orientation file (MERCURY.md or AGENTS.md), so here is an auto-derived surface map (a structure-only scan: languages, entry points, layout). Use it to orient instead of broad exploratory listing; verify anything load-bearing before relying on it, and prefer reading the repo's own docs where they exist.

${attachment.markdown}`
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
      const content = attachment.content
      if (!content || !content.contents || content.contents.length === 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }

      const transformedBlocks: ContentBlockParam[] = []

      for (const item of content.contents) {
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

      if (transformedBlocks.length > 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: transformedBlocks,
            isMeta: true,
          }),
        ])
      } else {
        logMCPDebug(
          attachment.server,
          `No displayable content found in MCP resource ${attachment.uri}.`,
        )
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No displayable content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }
    }
    case 'agent_mention': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user's message names the agent "${attachment.agentType}" — invoke that agent for this work, passing it the context it needs.`,
          isMeta: true,
        }),
      ])
    }
    case 'task_status': {
      const displayStatus =
        attachment.status === 'killed' ? 'stopped' : attachment.status

      if (attachment.status === 'killed') {
        return [
          createUserMessage({
            content: wrapInSystemReminder(
              `Task "${attachment.description}" (${attachment.taskId}) was stopped by the user.`,
            ),
            isMeta: true,
          }),
        ]
      }

      if (attachment.status === 'running') {
        const parts = [
          `Background agent "${attachment.description}" (${attachment.taskId}) is still running.`,
        ]
        if (attachment.deltaSummary) {
          parts.push(`Progress: ${attachment.deltaSummary}`)
        }
        if (attachment.outputFilePath) {
          parts.push(
            `Do NOT spawn a duplicate — you will be notified when it completes. Partial output is readable at ${attachment.outputFilePath}, and ${SEND_MESSAGE_TOOL_NAME} reaches it directly.`,
          )
        } else {
          parts.push(
            `Do NOT spawn a duplicate — you will be notified when it completes, and ${SEND_MESSAGE_TOOL_NAME} reaches it directly.`,
          )
        }
        return [
          createUserMessage({
            content: wrapInSystemReminder(parts.join(' ')),
            isMeta: true,
          }),
        ]
      }

      const messageParts: string[] = [
        `Task ${attachment.taskId}`,
        `(type: ${attachment.taskType})`,
        `(status: ${displayStatus})`,
        `(description: ${attachment.description})`,
      ]

      if (attachment.deltaSummary) {
        messageParts.push(`Delta: ${attachment.deltaSummary}`)
      }

      if (attachment.outputFilePath) {
        messageParts.push(
          `The result is in its output file: ${attachment.outputFilePath}`,
        )
      } else {
        messageParts.push('Its output file was not recorded.')
      }

      return [
        createUserMessage({
          content: wrapInSystemReminder(messageParts.join(' ')),
          isMeta: true,
        }),
      ]
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
            ? `reach it: ${SEND_MESSAGE_TOOL_NAME} to "${row.address}"`
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
        `A running agent is never re-spawned — its completion reaches you as a task notification on its own. A result that is owed is collected from that notification or from the output file, never re-derived. ${SEND_MESSAGE_TOOL_NAME} reaches a sub-agent by the id or name shown; a task's output is read from the output file shown with ${FILE_READ_TOOL_NAME}; ${TASK_STOP_TOOL_NAME} stops one.`,
      ].join('\n')
      return [createUserMessage({ content: wrapInSystemReminder(text), isMeta: true })]
    }
    case 'async_hook_response': {
      const response = attachment.response
      const messages: UserMessage[] = []

      if (response.systemMessage) {
        messages.push(
          createUserMessage({
            content: boundHookContext(response.systemMessage, `${attachment.hookName}-async-system`).text,
            isMeta: true,
          }),
        )
      }

      if (
        response.hookSpecificOutput &&
        'additionalContext' in response.hookSpecificOutput &&
        response.hookSpecificOutput.additionalContext
      ) {
        messages.push(
          createUserMessage({
            content: boundHookContext(response.hookSpecificOutput.additionalContext, `${attachment.hookName}-async-context`).text,
            isMeta: true,
          }),
        )
      }

      return wrapMessagesInSystemReminder(messages)
    }
    case 'token_usage':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Token usage: ${attachment.used}/${attachment.total}; ${attachment.remaining} remaining`,
          ),
          isMeta: true,
        }),
      ]
    case 'budget_usd':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `USD budget: $${attachment.used}/$${attachment.total}; $${attachment.remaining} remaining`,
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
    case 'hook_blocking_error':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook blocking error from command: "${attachment.blockingError.command}": ${boundHookContext(attachment.blockingError.blockingError, `${attachment.hookName}-block`).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_success':
      if (
        attachment.hookEvent !== 'SessionStart' &&
        attachment.hookEvent !== 'UserPromptSubmit'
      ) {
        return []
      }
      if (attachment.content === '') {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook success: ${boundHookContext(attachment.content, attachment.hookName).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_additional_context': {
      if (attachment.content.length === 0) {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook additional context: ${boundHookContext(attachment.content.join('\n'), `${attachment.hookName}-context`).text}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook_stopped_continuation':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook stopped continuation: ${boundHookContext(stoppedContinuationMessage(attachment), `${attachment.hookName}-stop`).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'compaction_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            'Auto-compact is enabled. When the context window is nearly full, older messages will be automatically summarized so you can continue working seamlessly. There is no need to stop or rush \u2014 you have unlimited context through automatic compaction.',
          isMeta: true,
        }),
      ])
    }
    case 'context_efficiency': {
      return []
    }
    case 'date_change': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The date has changed. Today's date is now ${attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.`,
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
          `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join('\n')}`,
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
    case 'agent_listing_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types for the Agent tool:'
          : 'New agent types are now available for the Agent tool:'
        parts.push(`${header}\n${attachment.addedLines.join('\n')}`)
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map(t => `- ${t}`).join('\n')}`,
        )
      }
      if (attachment.isInitial && attachment.showConcurrencyNote) {
        parts.push(
          `Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.`,
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
          `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${attachment.addedBlocks.join('\n\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following MCP servers have disconnected. Their instructions above no longer apply:\n${attachment.removedNames.join('\n')}`,
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
    case 'lane_boundary': {
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.boundary, isMeta: true }),
      ])
    }
    case 'verify_plan_reminder': {
      return []
    }
    case 'already_read_file':
    case 'command_permissions':
    case 'edited_image_file':
    case 'hook_cancelled':
    case 'hook_error_during_execution':
    case 'hook_non_blocking_error':
    case 'hook_system_message':
    case 'structured_output':
    case 'hook_permission_decision':
    case 'bypassed_ask':
      return []
    case 'bound_prefix':
      return []
    case 'dead_thinking':
    case 'images_left_out':
      return []
  }

  const LEGACY_ATTACHMENT_TYPES = [
    'autocheckpointing',
    'background_task_status',
    'todo',
    'todo_reminder',
    'task_progress',
    'ultramemory',
  ]
  if (LEGACY_ATTACHMENT_TYPES.includes((attachment as { type: string }).type)) {
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
      content: `Result of calling the ${tool.name} tool:\n${contentStr}`,
      isMeta: true,
    })
  } catch {
    return createUserMessage({
      content: `Result of calling the ${tool.name} tool: Error`,
      isMeta: true,
    })
  }
}

function createToolUseMessage(
  toolName: string,
  input: { [key: string]: string | number },
): UserMessage {
  return createUserMessage({
    content: `Called the ${toolName} tool with the following input: ${jsonStringify(input)}`,
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
