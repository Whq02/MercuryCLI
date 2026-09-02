// A successful tool result, rendered by the tool's own result renderer.
//
// Validation before rendering is load-bearing: resumed transcripts
// deserialise results with no validation, and a partial or old-format result
// crashes a renderer on first field access — so a declared output schema
// gates rendering, and a validation failure renders nothing.

import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import {
  filterToolProgressMessages,
  safeUserFacingName,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type {
  NormalizedUserMessage,
  ProgressMessage,
} from '../../../types/message.js'
import type { MessageLookups } from '../../../utils/messages/lookups.js'
import {
  deleteClassifierApproval,
  getClassifierApproval,
  getYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js'
import { summarizeToolResult } from '../../../utils/toolResultSummary.js'
import { logError } from '../../../utils/log.js'
import { getTheme } from '../../../utils/theme.js'
import { useTheme } from '../../design-system/ThemeProvider.js'
import { SentryErrorBoundary } from '../../SentryErrorBoundary.js'
import { HookProgressMessage } from '../HookProgressMessage.js'

export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode,
}: {
  message: NormalizedUserMessage
  lookups: MessageLookups
  toolUseID: string
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tool: Tool
  tools: Tools
  verbose: boolean
  width: number | string
  isTranscriptMode?: boolean
}): React.ReactNode {
  const [themeName] = useTheme()
  // Classifier-approval bookkeeping: the record for this tool use is captured
  // once at mount and deleted from the shared map so the map does not grow
  // with transcript length. The display rows are absent; the deletion is the
  // load-bearing part.
  useState(() => {
    const captured =
      getClassifierApproval(toolUseID) ?? getYoloClassifierApproval(toolUseID)
    deleteClassifierApproval(toolUseID)
    return captured ?? null
  })

  const result = message.toolUseResult
  if (result === undefined || result === null) return null

  let validated: unknown = result
  if (tool.outputSchema) {
    const parsed = tool.outputSchema.safeParse(result)
    if (!parsed.success) return null
    validated = parsed.data
  }

  // Compact view only: when the shared summariser produced an inline summary,
  // the tool card already showed it — this block stays silent. Keyed on the
  // TOOL-USE BLOCK's name (the same key the card uses), never the resolved
  // tool's registry name, so the two sites can never disagree.
  if (!verbose && !isTranscriptMode) {
    const blockName =
      lookups.toolUseByToolUseID.get(toolUseID)?.name ?? tool.name
    if (summarizeToolResult(blockName, result) !== null) return null
  }

  const toolUseBlock = lookups.toolUseByToolUseID.get(toolUseID)
  // Renderer-contract degrade path (mirrors the tool-use side): a result
  // renderer that throws degrades to an empty row, and one that returns a
  // bare primitive is wrapped in a styled text element — raw text outside
  // one crashes the Ink host at the app root and takes the session down.
  let rendered: React.ReactNode
  try {
    rendered = tool.renderToolResultMessage?.(
      validated,
      filterToolProgressMessages(progressMessagesForMessage),
      {
        style,
        theme: getTheme(themeName),
        tools,
        verbose,
        isTranscriptMode,
        input: toolUseBlock?.input,
        width,
      },
    )
  } catch (error) {
    logError(error)
    rendered = null
  }
  if (
    typeof rendered === 'string' ||
    typeof rendered === 'number' ||
    typeof rendered === 'bigint'
  ) {
    rendered = String(rendered) === '' ? null : <Text>{String(rendered)}</Text>
  }

  // Tools with an empty user-facing name render like plain assistant prose
  // and must stay unconstrained so table safety margins tuned for the prose
  // gutter still hold.
  const unconstrained = safeUserFacingName(tool, toolUseBlock?.input) === ''

  return (
    <Box flexDirection="column" width={unconstrained ? undefined : width}>
      {/* The renderer's RETURNED TREE can still throw at render time (a bare
          string reaching a Box trips Ink's invariant during host-instance
          creation — the Skill tool-result crash, operator-sighted): the
          try/catch above only covers the renderer CALL. Row-scoped boundary:
          a poisoned stored row degrades to one errored line and can never
          end the app — re-entering a session carrying one is safe. */}
      <SentryErrorBoundary>{rendered ?? null}</SentryErrorBoundary>
      <SentryErrorBoundary>
        <HookProgressMessage
          hookEvent="PostToolUse"
          toolUseID={toolUseID}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      </SentryErrorBoundary>
    </Box>
  )
}
