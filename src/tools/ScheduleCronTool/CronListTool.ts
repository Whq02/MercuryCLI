import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sessionScheduleRoster } from '../../services/saturn/sessionScheduleBridge.js'
import {
  buildCronListPrompt,
  CRON_CREATE_TOOL_NAME,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

/** Lists this session's schedules as the daemon last pushed them. */

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    schedules: z.array(
      z.object({
        id: z.string(),
        when: z.string(),
        kind: z.enum(['fire', 'birth']),
        nextFireMs: z.number().nullable(),
        paused: z.boolean().optional(),
      }),
    ),
    rosterKnown: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: 'list the active schedules',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => cronToolsMountable(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  async prompt() {
    return buildCronListPrompt()
  },
  async call() {
    const roster = sessionScheduleRoster()
    return {
      data: {
        schedules: (roster ?? []).map(row => ({
          id: row.id,
          when: row.when,
          kind: row.kind,
          nextFireMs: row.nextFireMs,
          ...(row.paused === true ? { paused: true } : {}),
        })),
        rosterKnown: roster !== null,
      } satisfies ListOutput,
    }
  },
  mapToolResultToToolResultBlockParam(output: ListOutput, toolUseID: string) {
    const content = !output.rosterKnown
      ? `No roster yet — the daemon pushes this session's schedules at the facts beat (a ${CRON_CREATE_TOOL_NAME} submission appears here once applied; a run without a session record holds none).`
      : output.schedules.length === 0
        ? 'No schedules on this session.'
        : output.schedules
            .map(row => {
              const next =
                row.nextFireMs === null
                  ? row.paused === true
                    ? 'paused'
                    : 'no future fire'
                  : `next ${new Date(row.nextFireMs).toISOString()}`
              return `${row.id}: ${row.when} (${row.kind}) — ${next}`
            })
            .join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
