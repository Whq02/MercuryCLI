import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sessionScheduleRoster, sessionScheduleRosterPushedAtMs } from '../../services/saturn/sessionScheduleBridge.js'
import type { SaturnFactsRowV1 } from '../../daemon/saturn.js'
import {
  buildCronListPrompt,
  CRON_CREATE_TOOL_NAME,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'


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
        title: z.string().optional(),
      }),
    ),
    rosterKnown: z.boolean(),
    pushedAtMs: z.number().optional(),
    pastDueHidden: z.number().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const PAST_FIRE_GRACE_MS = 60_000

export function pastDueFireRow(row: Pick<SaturnFactsRowV1, 'kind' | 'nextFireMs' | 'paused'>, nowMs: number): boolean {
  return row.kind === 'fire' && row.paused !== true && row.nextFireMs !== null && row.nextFireMs < nowMs - PAST_FIRE_GRACE_MS
}

export function rosterPushedWords(pushedAtMs: number | undefined): string {
  return pushedAtMs === undefined ? '' : ` Roster as the daemon pushed it at ${new Date(pushedAtMs).toISOString()}.`
}

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
  async prompt(options) {
    return buildCronListPrompt(options?.tools?.some(tool => tool.name === CRON_CREATE_TOOL_NAME) ?? true)
  },
  async call() {
    const roster = sessionScheduleRoster()
    const pushedAtMs = sessionScheduleRosterPushedAtMs()
    const now = Date.now()
    const standing = (roster ?? []).filter(row => !pastDueFireRow(row, now))
    const pastDueHidden = (roster ?? []).length - standing.length
    return {
      data: {
        schedules: standing.map(row => ({
          id: row.id,
          when: row.when,
          kind: row.kind,
          nextFireMs: row.nextFireMs,
          ...(row.paused === true ? { paused: true } : {}),
          ...(row.title !== undefined ? { title: row.title } : {}),
        })),
        rosterKnown: roster !== null,
        ...(roster !== null && pushedAtMs !== null ? { pushedAtMs } : {}),
        ...(pastDueHidden > 0 ? { pastDueHidden } : {}),
      } satisfies ListOutput,
    }
  },
  mapToolResultToToolResultBlockParam(output: ListOutput, toolUseID: string) {
    const hidden = output.pastDueHidden !== undefined && output.pastDueHidden > 0 ? ` ${output.pastDueHidden} fire row${output.pastDueHidden === 1 ? '' : 's'} whose fire time has passed ${output.pastDueHidden === 1 ? 'is' : 'are'} not shown.` : ''
    const content = !output.rosterKnown
      ? `No roster yet — the daemon pushes this session's schedules at the facts beat (a ${CRON_CREATE_TOOL_NAME} submission appears here once applied; a run without a session record holds none).`
      : output.schedules.length === 0
        ? `No schedules on this session.${rosterPushedWords(output.pushedAtMs)}${hidden}`
        : `${output.schedules
            .map(row => {
              const next =
                row.nextFireMs === null
                  ? row.paused === true
                    ? 'paused'
                    : 'no future fire'
                  : `next ${new Date(row.nextFireMs).toISOString()}`
              const named = row.title !== undefined ? ` · ${row.title}` : ''
              return `${row.id}${named}: ${row.when} (${row.kind}) — ${next}`
            })
            .join('\n')}${rosterPushedWords(output.pushedAtMs) === '' && hidden === '' ? '' : `\n${rosterPushedWords(output.pushedAtMs).trimStart()}${hidden}`}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
