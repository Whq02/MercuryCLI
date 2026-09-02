import { z } from 'zod/v4'
import * as React from 'react'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { findActiveCheckpoint } from '../../services/compact/checkpointRewind.js'
import { DESCRIPTION, REWIND_TOOL_NAME, REWIND_TOOL_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    report: z
      .string()
      .describe(
        'The carried-back handoff: findings, decisions, exact paths, next steps. Required, non-empty after trim.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Human-readable confirmation'),
    goal: z.string().describe('The checkpoint goal being returned to'),
    abandonedMessages: z.number().describe('How many messages the rewind will drop from context'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/**
 * Rewind — return to the active Checkpoint (spec 07-C4). The tool VALIDATES
 * and reports; the turn machine appends the rewind record at the end of the
 * tool round (buildRewindRecordIfSettled), and the request projection
 * excludes the abandoned window from the next provider call. Context-only:
 * files/git are never touched.
 */
export const RewindTool = buildTool({
  name: REWIND_TOOL_NAME,
  searchHint: 'rewind context to the checkpoint, carry a report back',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Rewind',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return REWIND_TOOL_PROMPT
  },
  getActivityDescription() {
    return 'Rewinding to the checkpoint'
  },
  renderToolUseMessage(input) {
    const r = input?.report ?? ''
    return r.length > 80 ? `${r.slice(0, 77)}…` : r
  },
  renderToolResultMessage(output) {
    return (
      <Text dimColor>
        {output.message}
      </Text>
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call({ report }, context) {
    const trimmed = report.trim()
    if (trimmed.length === 0) {
      throw new Error(
        'refused: the report is empty — the report is the one artifact that survives the rewind; write the findings before rewinding.',
      )
    }
    const messages = context.messages ?? []
    const active = findActiveCheckpoint(messages)
    if (active === null) {
      // Covers both "never checkpointed" and "already rewound" (double-
      // rewind): the scan sees no active checkpoint in either case.
      throw new Error(
        'refused: no active checkpoint — Checkpoint { goal } takes one before an exploration; a checkpoint already rewound cannot be rewound again.',
      )
    }
    const abandoned = Math.max(0, messages.length - (active.boundaryIndex + 1))
    return {
      data: {
        message:
          `Rewind accepted — applies at the end of this turn. The next model call sees the pre-exploration context ` +
          `(${abandoned} message(s) leave the model context; the operator's transcript keeps them; files/git untouched).`,
        goal: active.goal,
        abandonedMessages: abandoned,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
