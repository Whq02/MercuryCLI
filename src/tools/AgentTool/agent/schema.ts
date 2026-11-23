import { z } from 'zod'
import { semanticBoolean } from '../../../utils/semanticBoolean.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../../utils/effort.js'
import { lazySchema } from '../../../utils/lazySchema.js'
import { agentToolResultSchema } from '../agentToolUtils.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../../constants/tools/agent.js'
import type { AgentToolProgress, ShellProgress } from '../../../types/tools.js'
import type { describeAgentRuntimeRef } from '../../../services/providers/primaryBackend.js'
export type Progress = AgentToolProgress | ShellProgress

export const BACKGROUND_TASKS_DISABLED = false

export const DEFAULT_AGENT_TYPE = MERCURY_CREW_AGENT_TYPE

export type AgentToolInput = {
  description: string
  prompt: string
  name?: string
  team?: string
  crewmate_type?: string
  captain?: boolean
  model?: string
  mode?: string
  effort?: EffortLevel
  cwd?: string
  worktree_at?: string
  review_receipt?: string
  isolation?: 'worktree'
  run_in_background?: boolean
  output_schema?: Record<string, unknown>
  schema_mode?: 'permissive' | 'strict'
}

const CWD_PARAM_DESCRIPTION =
  "Absolute starting directory. Starting outside the session's folder asks for permission; with isolation, its repository supplies the worktree that becomes the child's directory."

const TEAM_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u

export const inputSchema = lazySchema(() =>
  z
    .object({
      description: z.string().describe('Short (3-5 word) task summary'),
      prompt: z
        .string()
        .describe(
          'Task brief: objective, evidence, boundaries, acceptance criteria and whether to implement or research.',
        ),
      crewmate_type: z
        .string()
        .optional()
        .describe(`Crewmate type (default ${DEFAULT_AGENT_TYPE}).`),
      model: z
        .string()
        .optional()
        .describe(
          "Exact model id or family word; read mercury://models. [1m] selects the 1M variant; your own family keeps your exact model. Overrides the agent definition; omitted, the definition's model, else the configured crewmate default, else yours. Follow the operator's model and effort; never downgrade to obtain read-only scoping.",
        ),
      effort: z
        .enum(EFFORT_LEVELS)
        .optional()
        .describe(
          "Reasoning effort; omitted, the agent definition's effort, else the configured crewmate default (high unless the operator changed it), never the parent level. An unsupported level maps to the nearest served level; models without effort control ignore it.",
        ),
      ...(BACKGROUND_TASKS_DISABLED
        ? {}
        : {
            run_in_background: semanticBoolean(z.boolean().optional()).describe(
              'Run asynchronously: acknowledge now, notify on completion.',
            ),
          }),
      name: z
        .string()
        .refine(value => !value.includes('@') && value !== '*', {
          message:
            'A crewmate name must be addressable by SendMessage and ResumeCrewmate: it cannot contain "@" or be "*".',
        })
        .optional()
        .describe(
          'Seat name for later messages and additional work; omitted, the crewmate runs its brief once.',
        ),
      team: z
        .string()
        .refine(
          value =>
            TEAM_PATTERN.test(value) &&
            value.toLowerCase() !== 'all' &&
            value.toLowerCase() !== 'general',
        )
        .optional()
        .describe('Crew-board team label (delivery only, not privacy).'),
      captain: z
        .boolean()
        .optional()
        .describe(
          'Appoint this named seat as its team captain. Requires name, team, swarm enrollment and the lead; a team of five or more needs one before its fifth seat.',
        ),
      isolation: z
        .literal('worktree')
        .optional()
        .describe(
          'Temporary git worktree; kept unlocked when the crewmate ends, with its path and branch in the result.',
        ),
      worktree_at: z
        .string()
        .optional()
        .describe("With isolation 'worktree': commit ref for a detached, frozen worktree."),
      cwd: z.string().optional().describe(CWD_PARAM_DESCRIPTION),
      review_receipt: z
        .string()
        .optional()
        .describe(
          'Absolute path to existing Markdown report outside worktree; only "## Review" may be edited (requires isolation + worktree_at).',
        ),
      output_schema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'JSON Schema for the final answer. The result carries the checked JSON with status valid, missing or invalid; valid means schema-valid, not independently verified.',
        ),
      schema_mode: z
        .enum(['permissive', 'strict'])
        .optional()
        .describe(
          'With output_schema: \'strict\' fails the call when none passed; \'permissive\' (default) returns the prose under status "missing" or "invalid".',
        ),
    })
    .refine(
      value =>
        value.captain !== true ||
        (typeof value.name === 'string' &&
          value.name.trim() !== '' &&
          typeof value.team === 'string' &&
          value.team !== ''),
      { message: 'A captain launch needs name and team.' },
    ),
)

export const outputSchema = lazySchema(() =>
  z.union([
    agentToolResultSchema().extend({
      status: z.literal('completed'),
      prompt: z.string(),
      worktreePath: z.string().optional(),
      worktreeBranch: z.string().optional(),
    }),
    agentToolResultSchema().extend({
      status: z.literal('failed'),
      error: z.string(),
      prompt: z.string(),
      lastCalls: z.array(z.string()).optional(),
      worktreePath: z.string().optional(),
      worktreeBranch: z.string().optional(),
    }),
    z.object({
      status: z.literal('async_launched'),
      agentId: z.string().describe("The launched crewmate's id"),
      description: z.string().describe('The task description'),
      prompt: z.string().describe('The prompt handed to the crewmate'),
      outputFile: z.string().describe('Output-file path for progress checks'),
      canReadOutputFile: z
        .boolean()
        .optional()
        .describe('Whether the caller can read the output file'),
      modelNote: z.string().optional().describe('The engine note'),
      agentName: z
        .string()
        .optional()
        .describe('The name the launch gave the crewmate — an address beside the id'),
      backgroundReason: z
        .enum([
          'turn-interrupted',
          'backgrounded',
          'agent-type',
          'sibling-ended',
          'message-queued',
        ])
        .optional()
        .describe(
          'Why a foreground ask ran in the background: the turn was interrupted, the crewmate was moved, the type always does, a sibling crewmate failed or stopped and the group wait returned, or the operator sent a message while the crewmate held the turn',
        ),
      siblingEnd: z
        .object({
          taskId: z.string(),
          description: z.string(),
          status: z.enum(['failed', 'stopped']),
          error: z.string().optional(),
        })
        .optional()
        .describe('The sibling whose failure or stop returned the group wait'),
    }),
  ]),
)

export type AgentToolOutput = z.infer<ReturnType<typeof outputSchema>> & {
  isAsync?: true
  agentName?: string
  runtimeRef?: ReturnType<typeof describeAgentRuntimeRef>
}
