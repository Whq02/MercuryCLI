import type { AssistantMessage, Message } from '../types/message.js'
import { EMPTY_USAGE } from '../utils/api/emptyUsage.js'
import { updateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import { refusalAnsweredBy } from '../services/providers/toolCallGate.js'
import { itemRowsOf, refusedCallRowsOf, stepRow, toolResultRowsOf, type RowDraft, type RowScope } from './project.js'
import { notBuilt } from '../pi/holes.js'

const messages = new Map<string, { block: number; stepped: boolean; seen: Set<string> }>()

export function childRowsOf(scope: RowScope & { parent_call_id: string }, message: Message): RowDraft[] {
  return notBuilt('src/rows/child.ts:9')
}
