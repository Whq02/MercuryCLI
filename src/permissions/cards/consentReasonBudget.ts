import { wrapText } from '../../platform/text/truncate.js'
import type { PermissionDecisionReason } from '../rules/permissions.js'

type WrappedReason = Extract<PermissionDecisionReason, { type: 'safetyCheck' }>

export const ROWS_ROUND_THE_CARD_TEXT = 8

export function drawnRows(text: string, width: number): number {
  return wrapText(text, width, 'wrap').split('\n').length
}

export function reasonCutToFit(
  reason: PermissionDecisionReason | undefined,
  width: number,
  budget: number,
): WrappedReason | null {
  if (reason?.type !== 'safetyCheck' || !reason.operatorOnly) return null
  const drawn = wrapText(reason.reason, width, 'wrap').split('\n')
  if (drawn.length <= Math.max(budget, 3)) return null
  const kept = Math.max(2, budget - 1)
  const tail = Math.floor(kept / 2)
  const hidden = drawn.length - kept
  return { ...reason, reason: [...drawn.slice(0, kept - tail), `… +${hidden} more lines`, ...drawn.slice(drawn.length - tail)].join('\n') }
}
