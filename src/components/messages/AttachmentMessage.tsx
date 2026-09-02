// One row (or none) per attachment kind — the transcript's vocabulary for
// what the harness put into, or learned about, your context. The default
// branch asserts membership of the null-rendering registry, so a new
// attachment type without either a render case or a registry entry fails
// typecheck (the only thing keeping the two lists honest).

import React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { formatFileSize } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  isIdleNotification,
  isShutdownApproved,
} from '../../utils/teammateMailbox.js'
import { toInkColor } from '../../utils/ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js'
import { MessageResponse } from '../MessageResponse.js'
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js'
import { TeammateMessageContent } from './UserTeammateMessage.js'
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js'
import { tryRenderTaskAssignmentMessage } from './TaskAssignmentMessage.js'
import { UserImageMessage } from './UserImageMessage.js'
import { UserTextMessage } from './UserTextMessage.js'
import { useSelectedMessageBg } from '../messageActions.js'

/** The shared line element: a dim, wrapping line inside the response
 *  gutter, on the selection background. */
function AttachmentLine({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="wrap">
        {children}
      </Text>
    </MessageResponse>
  )
}

/** The folded hook-output block all three hook-error cards embed: the
 *  opening output line (every line when verbose), a countable fold marker,
 *  and a connector row naming the hook and pointing at /hooks. An empty
 *  output points at the debug log instead of fabricating a body. */
function HookOutputBlock({
  output,
  hookName,
  hookEvent,
  verbose,
}: {
  output: string
  hookName: string
  hookEvent: string
  verbose: boolean
}): React.ReactNode {
  const lines = output.split('\n').filter(line => line !== '')
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? (
        <AttachmentLine>Hook output is in the debug log.</AttachmentLine>
      ) : verbose ? (
        lines.map((line, index) => (
          <Text key={index} dimColor>
            {line}
          </Text>
        ))
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{lines[0]}</Text>
          {lines.length > 1 ? (
            <Text dimColor>
              … +{lines.length - 1} {plural(lines.length - 1, 'line')}{' '}
              <CtrlOToExpand />
            </Text>
          ) : null}
        </Box>
      )}
      <AttachmentLine>
        {hookName} · {hookEvent} · /hooks
      </AttachmentLine>
    </Box>
  )
}

export function AttachmentMessage({
  addMargin = false,
  attachment,
  verbose = false,
  isTranscriptMode = false,
}: {
  addMargin?: boolean
  attachment: Attachment
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  // The selected-message background belongs on the box that owns the top
  // margin, so the margin row is not painted.
  const selectedBg = useSelectedMessageBg()
  // Handled before the main dispatch.
  if (attachment.type === 'teammate_mailbox') {
    if (!isAgentSwarmsEnabled()) return null
    // Hidden payloads are filtered BEFORE counting, so a count never sits
    // over nothing.
    const surviving = attachment.messages.filter(message => {
      if (isIdleNotification(message.text)) return false
      if (isShutdownApproved(message.text)) return false
      try {
        const parsed = JSON.parse(message.text) as { type?: string }
        if (parsed?.type === 'teammate_terminated') return false
      } catch {
        // Not JSON — keep it.
      }
      return true
    })
    if (surviving.length === 0) return null
    return (
      <Box
        flexDirection="column"
        marginTop={addMargin ? 1 : 0}
        backgroundColor={selectedBg}
      >
        {surviving.map((message, index) => {
          const senderName = message.from
          const assignment = tryRenderTaskAssignmentMessage(
            message.text,
            senderName,
          )
          if (assignment) {
            return <React.Fragment key={index}>{assignment}</React.Fragment>
          }
          const plan = tryRenderPlanApprovalMessage(message.text, senderName)
          if (plan) return <React.Fragment key={index}>{plan}</React.Fragment>
          return (
            <TeammateMessageContent
              key={index}
              message={{
                teammateId: message.from,
                color: message.color,
                summary: message.summary,
                content: message.text,
              }}
              isTranscriptMode={isTranscriptMode}
            />
          )
        })}
      </Box>
    )
  }
  if (attachment.type === 'skill_discovery') return null

  switch (attachment.type) {
    case 'directory':
      return (
        <AttachmentLine>
          Listed directory{' '}
          <Text bold>
            {attachment.displayPath.endsWith('/')
              ? attachment.displayPath
              : `${attachment.displayPath}/`}
          </Text>
        </AttachmentLine>
      )

    case 'file':
    case 'already_read_file': {
      const content = attachment.content
      if (content.type === 'notebook') {
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> (
            {content.file.cells.length} {plural(content.file.cells.length, 'cell')})
          </AttachmentLine>
        )
      }
      if (attachment.type === 'already_read_file') {
        return (
          <AttachmentLine>
            Re-read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </AttachmentLine>
        )
      }
      if (content.type === 'text') {
        return (
          <AttachmentLine>
            Read <Text bold>{attachment.displayPath}</Text> (
            {content.file.numLines}
            {attachment.truncated ? '+' : ''} {plural(content.file.numLines, 'line')})
          </AttachmentLine>
        )
      }
      const size =
        content.type === 'pdf' ? content.file.originalSize : undefined
      return (
        <AttachmentLine>
          Read <Text bold>{attachment.displayPath}</Text>
          {size !== undefined ? ` (${formatFileSize(size)})` : ''}
        </AttachmentLine>
      )
    }

    case 'compact_file_reference':
      return (
        <AttachmentLine>
          Referenced <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'pdf_reference':
      return (
        <AttachmentLine>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> (
          {attachment.pageCount} {plural(attachment.pageCount, 'page')})
        </AttachmentLine>
      )

    case 'selected_lines_in_ide': {
      const lines =
        (attachment as { lineEnd?: number; lineStart: number }).lineEnd !==
        undefined
          ? ((attachment as { lineEnd?: number }).lineEnd ?? 0) -
            attachment.lineStart +
            1
          : 1
      return (
        <AttachmentLine>
          {lines} {plural(lines, 'line')} selected in {attachment.ideName}
        </AttachmentLine>
      )
    }

    case 'nested_memory':
      return (
        <AttachmentLine>
          Loaded instruction file <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'relevant_memories': {
      const count = attachment.memories.length
      if (count === 0) return null
      if (!verbose && !isTranscriptMode) {
        return (
          <AttachmentLine>
            Recalled {count} {plural(count, 'memory')} <CtrlOToExpand />
          </AttachmentLine>
        )
      }
      return (
        <Box flexDirection="column">
          <AttachmentLine>
            Recalled {count} {plural(count, 'memory')}
          </AttachmentLine>
          {attachment.memories.map(memory => {
            const basename = memory.path.split(/[\\/]/).pop() ?? memory.path
            return (
              <Box key={memory.path} flexDirection="column" paddingLeft={2}>
                <Text dimColor>
                  <Link url={`file://${memory.path}`} fallback={basename}>
                    {basename}
                  </Link>
                </Text>
                {isTranscriptMode ? <Ansi dimColor>{memory.content}</Ansi> : null}
              </Box>
            )
          })}
        </Box>
      )
    }

    case 'dynamic_skill':
      return (
        <AttachmentLine>
          Loaded {attachment.skillNames.length}{' '}
          {plural(attachment.skillNames.length, 'skill')} from{' '}
          <Text bold>{attachment.displayPath}</Text>
        </AttachmentLine>
      )

    case 'skill_listing':
      if (attachment.isInitial) return null
      return (
        <AttachmentLine>
          {attachment.skillCount} {plural(attachment.skillCount, 'skill')}{' '}
          available
        </AttachmentLine>
      )

    case 'agent_listing_delta':
      if (attachment.isInitial || attachment.addedTypes.length === 0) return null
      return (
        <AttachmentLine>
          {attachment.addedTypes.length}{' '}
          {plural(attachment.addedTypes.length, 'agent type')} available
        </AttachmentLine>
      )

    case 'queued_command': {
      const prompt = attachment.prompt
      const text =
        typeof prompt === 'string'
          ? prompt
          : prompt
              .filter(block => block.type === 'text')
              .map(block => (block as { text: string }).text)
              .join('\n')
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          backgroundColor={selectedBg}
        >
          <UserTextMessage
            addMargin={false}
            param={{ type: 'text', text }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
          {(attachment.imagePasteIds ?? []).map(id => (
            <UserImageMessage key={id} imageId={id} />
          ))}
        </Box>
      )
    }

    case 'plan_file_reference':
      return (
        <AttachmentLine>
          Referenced plan file <Text bold>{attachment.planFilePath}</Text>
        </AttachmentLine>
      )

    case 'invoked_skills': {
      if (attachment.skills.length === 0) return null
      return (
        <AttachmentLine>
          Restored {plural(attachment.skills.length, 'skill')}{' '}
          {attachment.skills.map(skill => skill.name).join(', ')}
        </AttachmentLine>
      )
    }

    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />

    case 'mcp_resource':
      return (
        <AttachmentLine>
          Read MCP resource <Text bold>{attachment.name}</Text> from{' '}
          {attachment.server}
        </AttachmentLine>
      )

    case 'command_permissions':
      // The skill tool's own result message covers it.
      return null

    case 'async_hook_response': {
      if (!verbose) return null
      if (attachment.hookEvent === 'SessionStart') return null
      return (
        <AttachmentLine>
          Async hook {attachment.hookEvent} completed
        </AttachmentLine>
      )
    }

    case 'hook_blocking_error': {
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      const blocking = attachment.blockingError as {
        blockingError?: string
        message?: string
      }
      return (
        <Box flexDirection="column">
          <Text color="error">
            Hook {attachment.hookName} blocked this action
          </Text>
          <HookOutputBlock
            output={String(
              blocking?.blockingError ?? blocking?.message ?? '',
            )}
            hookName={attachment.hookName}
            hookEvent={attachment.hookEvent}
            verbose={verbose}
          />
        </Box>
      )
    }

    case 'hook_non_blocking_error': {
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      const output = attachment.stderr !== '' ? attachment.stderr : attachment.stdout
      return (
        <Box flexDirection="column">
          <Text color="error">Hook {attachment.hookName} reported an error</Text>
          <HookOutputBlock
            output={output}
            hookName={attachment.hookName}
            hookEvent={attachment.hookEvent}
            verbose={verbose}
          />
        </Box>
      )
    }

    case 'hook_error_during_execution': {
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      return (
        <Box flexDirection="column">
          <Text color="warning">
            Hook {attachment.hookName} failed while running (nothing was
            blocked)
          </Text>
          <HookOutputBlock
            output={attachment.content}
            hookName={attachment.hookName}
            hookEvent={attachment.hookEvent}
            verbose={verbose}
          />
        </Box>
      )
    }

    case 'hook_success':
      // Full output goes to the debug log.
      return null

    case 'hook_stopped_continuation':
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      return (
        <Text color="warning">
          Hook {attachment.hookName} stopped continuation: {attachment.message}
        </Text>
      )

    case 'hook_system_message':
      return (
        <AttachmentLine>
          {attachment.content} — {attachment.hookName}
        </AttachmentLine>
      )

    case 'hook_permission_decision':
      return (
        <AttachmentLine>
          {attachment.decision === 'allow' ? 'Allowed' : 'Denied'} by the{' '}
          {attachment.hookEvent} hook
        </AttachmentLine>
      )

    case 'task_status': {
      const isTeammate =
        isAgentSwarmsEnabled() &&
        (attachment.taskType as string) === 'in_process_teammate'
      if (isTeammate) {
        const color = toInkColor(undefined)
        return (
          <AttachmentLine>
            <Text color={color}>@{attachment.description}</Text>{' '}
            {attachment.status === 'completed'
              ? 'shut down cleanly'
              : String(attachment.status)}
          </AttachmentLine>
        )
      }
      const description = `"${attachment.description}"`
      switch (String(attachment.status)) {
        case 'completed':
          return (
            <AttachmentLine>
              {description} finished in the background
            </AttachmentLine>
          )
        case 'killed':
          return <AttachmentLine>{description} was stopped</AttachmentLine>
        case 'running':
          return (
            <AttachmentLine>
              {description} is still running in the background
            </AttachmentLine>
          )
        default:
          return (
            <AttachmentLine>
              {description} {String(attachment.status)}
            </AttachmentLine>
          )
      }
    }

    case 'teammate_shutdown_batch':
      return (
        <AttachmentLine>
          {attachment.count} {plural(attachment.count, 'teammate')} shut down
          cleanly
        </AttachmentLine>
      )

    default: {
      // The type system keeps the registry honest: this assignment fails to
      // compile when a new attachment type has neither a render case above
      // nor a registry entry.
      const nullRendering: NullRenderingAttachmentType = attachment.type
      void nullRendering
      return null
    }
  }
}

export default AttachmentMessage
