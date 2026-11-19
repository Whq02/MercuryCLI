import { isClaudeAISubscriber } from '../../utils/auth.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import type { SystemCloseUsageMessage } from '../../types/message.js'
import { closeRow, modelUsageRows, type RowScope } from '../project.js'

export const costUnknownIn = (unpricedTurns: Record<string, number>, subscriber: boolean) => (model: string): boolean => (unpricedTurns[model] ?? 0) > 0 || (subscriber && declaredRouteOf(model) === 'anthropic')

export function closeRowOf(scope: RowScope, note: Pick<SystemCloseUsageMessage, 'closeState' | 'noteChars' | 'usage' | 'spent'>): ReturnType<typeof closeRow> {
  const models = modelUsageRows(note.spent?.modelUsage, costUnknownIn(note.spent?.unpricedTurns ?? {}, isClaudeAISubscriber()))
  return closeRow(scope, {
    state: note.closeState,
    ...(note.noteChars !== undefined ? { noteChars: note.noteChars } : {}),
    ...(note.usage !== undefined ? { usage: note.usage } : {}),
    ...(Object.keys(models).length > 0 ? { models } : {}),
  })
}
