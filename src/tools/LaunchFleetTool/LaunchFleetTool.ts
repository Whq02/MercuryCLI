import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  blockTask,
  createTask,
  deleteTask,
  getTaskListId,
} from '../../utils/tasks.js'
import { getTeamName } from '../../utils/teammate.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { LAUNCH_FLEET_TOOL_NAME } from './constants.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { DESCRIPTION, getPrompt } from './prompt.js'


const subtaskSchema = lazySchema(() =>
  z.object({
    content: z
      .string()
      .min(1)
      .describe('What needs to be done (the subtask subject + description)'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present-continuous spinner label shown while in_progress (e.g. "Running tests")',
      ),
    owner: z
      .string()
      .optional()
      .describe('Teammate/agent to assign this subtask to'),
    dependsOn: z
      .array(z.number().int().nonnegative())
      .optional()
      .describe(
        'Indices (into this subtasks array) of subtasks that must complete first. Each index must be EARLIER than this subtask (a valid DAG).',
      ),
  }),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    subtasks: z
      .array(subtaskSchema())
      .min(1)
      .describe('The subtasks to fan out as one grouped mission'),
    missionId: z
      .string()
      .optional()
      .describe('Optional explicit mission id; auto-generated when omitted'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    missionId: z.string(),
    taskIds: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function generateMissionId(): string {
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const LaunchFleetTool = buildTool({
  name: LAUNCH_FLEET_TOOL_NAME,
  searchHint:
    'fan out a mission — atomically create dependency-ordered subtasks under one missionId',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt({ tools }) {
    return getPrompt(new Set(tools.map(tool => tool.name)))
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'LaunchFleet'
  },
  shouldDefer: true,
  isEnabled() {
    return isAgentSwarmsEnabled() && evaluateLaunchAuthority('subagents').allowed
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `launch fleet of ${Array.isArray(input.subtasks) ? input.subtasks.length : 0} subtask(s)`
  },
  renderToolUseMessage() {
    return null
  },
  async validateInput(input) {
    for (let i = 0; i < input.subtasks.length; i++) {
      const deps = input.subtasks[i]!.dependsOn ?? []
      for (const d of deps) {
        if (d >= i) {
          return {
            result: false,
            message: `subtask ${i}: dependsOn index ${d} must be EARLIER than ${i} (a subtask can only depend on ones listed before it).`,
            errorCode: 9,
          }
        }
        if (d < 0 || d >= input.subtasks.length) {
          return {
            result: false,
            message: `subtask ${i}: dependsOn index ${d} is out of range (0..${input.subtasks.length - 1}).`,
            errorCode: 9,
          }
        }
      }
    }
    return { result: true }
  },
  async call(input, context) {
    const taskListId = getTaskListId()
    const missionId = input.missionId?.trim() || generateMissionId()

    const teamName = getTeamName(context.getAppState().teamContext)
    if (teamName) {
      const members = (await readTeamFileAsync(teamName))?.members ?? []
      const memberNames = new Set(members.map(m => m.name))
      for (const st of input.subtasks) {
        const owner = st.owner?.trim()
        if (owner && !memberNames.has(owner)) {
          throw new Error(
            `LaunchFleet: subtask owner "${owner}" is not a current team member ` +
              `(${[...memberNames].join(', ') || 'none'}) — that task would be ` +
              `unclaimable. Fix the owner or leave it unassigned.`,
          )
        }
      }
    }

    const taskIds: string[] = []
    try {
      for (const st of input.subtasks) {
        const id = await createTask(taskListId, {
          subject: st.content,
          description: st.content,
          activeForm: st.activeForm,
          status: 'pending',
          owner: st.owner,
          blocks: [],
          blockedBy: [],
          metadata: { missionId },
        })
        taskIds.push(id)
      }

      for (let i = 0; i < input.subtasks.length; i++) {
        const deps = input.subtasks[i]!.dependsOn ?? []
        for (const j of deps) {
          const wired = await blockTask(taskListId, taskIds[j]!, taskIds[i]!)
          if (!wired) {
            throw new Error(
              `LaunchFleet: dependency ${j}→${i} failed to wire (a subtask could not be found) — rolling back the mission.`,
            )
          }
        }
      }
    } catch (e) {
      const orphaned: string[] = []
      for (const id of taskIds) {
        try {
          if ((await deleteTask(taskListId, id)) === false) orphaned.push(id)
        } catch {
          orphaned.push(id)
        }
      }
      const base = e instanceof Error ? e.message : String(e)
      throw new Error(
        orphaned.length
          ? `${base} (rollback could NOT delete ${orphaned.length} task(s): ${orphaned.join(', ')} — they may be orphaned; clean up manually)`
          : base,
      )
    }

    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        missionId,
        taskIds,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { missionId, taskIds } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Fleet launched as mission ${missionId}: created ${taskIds.length} task(s) — ${taskIds
        .map(id => `#${id}`)
        .join(', ')}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
