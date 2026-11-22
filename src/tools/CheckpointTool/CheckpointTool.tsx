import { z } from 'zod/v4'
import { findActiveCheckpoint } from '../../services/compact/checkpointRewind.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { contextOnlyTraits, refusal } from './contextOnlyTool.js'
import { CHECKPOINT_TOOL_NAME, CHECKPOINT_TOOL_PROMPT, DESCRIPTION } from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    goal: z.string().min(1).describe('What the exploration sets out to learn or attempt; echoed back at the rewind.'),
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
type Output = z.infer<OutputSchema>

const nestedCheckpoint = (goal: string | undefined): Error =>
  refusal(`a checkpoint is already active${goal ? ` (goal: ${goal})` : ''} — Rewind { report } first; nested checkpoints are not supported.`)

const taken = (count: number): string =>
  `Checkpoint taken (${count} messages). Rewind { report } restores this context state; files and git are never touched.`

export const CheckpointTool: Unbuilt = unbuilt('src/tools/CheckpointTool/CheckpointTool.tsx:32')
