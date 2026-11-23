import { z } from 'zod/v4'

import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
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

function rosterPushedWords(pushedAtMs: number | undefined): string {
  return pushedAtMs === undefined ? '' : ` Roster as the daemon pushed it at ${new Date(pushedAtMs).toISOString()}.`
}

export const CronListTool: Tool<InputSchema, ListOutput> = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: 'list the active schedules',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  isEnabled: () => cronToolsMountable(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  async prompt() {
    return buildCronListPrompt()
  },
  async call() {
    const roster = sessionScheduleRoster()
    const pushedAtMs = sessionScheduleRosterPushedAtMs()
    const nowMs = Date.now()
    if (roster === null) {
      return { data: { schedules: [], rosterKnown: false } }
    }
    let pastDueHidden = 0
    const schedules: ListOutput['schedules'] = []
    for (const row of roster) {
      if (pastDueFireRow(row, nowMs)) {
        pastDueHidden += 1
        continue
      }
      schedules.push({
        id: row.id,
        when: row.when,
        kind: row.kind,
        nextFireMs: row.nextFireMs,
        ...(row.paused === true ? { paused: true } : {}),
        ...(row.title !== undefined ? { title: row.title } : {}),
      })
    }
    return {
      data: {
        schedules,
        rosterKnown: true,
        ...(pushedAtMs !== null ? { pushedAtMs } : {}),
        ...(pastDueHidden > 0 ? { pastDueHidden } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: ListOutput, toolUseID: string) {
    if (!output.rosterKnown) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `No roster yet — the daemon pushes this session's schedules at the facts beat (a ${CRON_CREATE_TOOL_NAME} submission appears here once applied; a run without a session record holds none).`,
      }
    }
    const pushed = rosterPushedWords(output.pushedAtMs)
    const hiddenCount = output.pastDueHidden ?? 0
    const hidden =
      hiddenCount > 0
        ? hiddenCount === 1
          ? ' 1 fire row whose fire time has passed is not shown.'
          : ` ${hiddenCount} fire rows whose fire time has passed are not shown.`
        : ''
    if (output.schedules.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `No schedules on this session.${pushed}${hidden}`,
      }
    }
    const lines = output.schedules.map(row => {
      const title = row.title !== undefined ? ` · ${row.title}` : ''
      const next =
        row.nextFireMs === null
          ? row.paused
            ? 'paused'
            : 'no future fire'
          : `next ${new Date(row.nextFireMs).toISOString()}`
      return `${row.id}${title}: ${row.when} (${row.kind}) — ${next}`
    })
    const footer = pushed !== '' || hidden !== '' ? `\n${pushed.trimStart()}${hidden}` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${lines.join('\n')}${footer}`,
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
