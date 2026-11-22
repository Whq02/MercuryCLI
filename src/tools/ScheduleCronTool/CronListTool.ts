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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'
export type ListOutput = Unbuilt

export const PAST_FIRE_GRACE_MS = 60_000

export function pastDueFireRow(row: Pick<SaturnFactsRowV1, 'kind' | 'nextFireMs' | 'paused'>, nowMs: number): boolean {
  return row.kind === 'fire' && row.paused !== true && row.nextFireMs !== null && row.nextFireMs < nowMs - PAST_FIRE_GRACE_MS
}

function rosterPushedWords(pushedAtMs: number | undefined): string {
  return pushedAtMs === undefined ? '' : ` Roster as the daemon pushed it at ${new Date(pushedAtMs).toISOString()}.`
}

export const CronListTool: Unbuilt = unbuilt('src/tools/ScheduleCronTool/CronListTool.ts:50')
