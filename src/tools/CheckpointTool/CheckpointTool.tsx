import { z } from 'zod/v4'
import * as React from 'react'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { findActiveCheckpoint } from '../../services/compact/checkpointRewind.js'
import { CHECKPOINT_TOOL_NAME, CHECKPOINT_TOOL_PROMPT, DESCRIPTION } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    goal: z
      .string()
      .min(1)
      .describe('What the exploration sets out to learn or attempt — echoed back on Rewind.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Human-readable confirmation'),
    goal: z.string().describe('The recorded goal'),
    messageCount: z.number().describe('Messages in the conversation at checkpoint time'),
    takenAt: z.string().describe('ISO timestamp of the checkpoint'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const CheckpointTool = buildTool({
  shouldDefer: true,
  name: CHECKPOINT_TOOL_NAME,
  searchHint: 'checkpoint / mark context state before an exploration, rewindable',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Checkpoint',
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
    return CHECKPOINT_TOOL_PROMPT
  },
  getActivityDescription(input) {
    return input?.goal ? `Checkpointing: ${input.goal}` : 'Checkpointing'
  },
  renderToolUseMessage(input) {
    return input?.goal ?? ''
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
  async call({ goal }, context) {
    const messages = context.messages ?? []
    const active = findActiveCheckpoint(messages)
    if (active !== null) {
      throw new Error(
        `refused: a checkpoint is already active${active.goal ? ` (goal: ${active.goal})` : ''} — ` +
          `Rewind { report } first; nested checkpoints are not supported.`,
      )
    }
    const takenAt = new Date().toISOString()
    return {
      data: {
        message: `Checkpoint taken (${messages.length} messages). Rewind { report } restores this context state; files and git are never touched.`,
        goal,
        messageCount: messages.length,
        takenAt,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
