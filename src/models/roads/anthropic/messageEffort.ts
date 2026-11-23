import type { EffortLevel } from '../../effort/effortLadder.js'

type MessageEffortStep = { after: number; effort: EffortLevel }

let refusal: object | null = null

export function messageEffortSteps(
  rows: readonly { type: string; replyEffort?: EffortLevel }[],
  sessionEffort: string | null | undefined,
): MessageEffortStep[] {
  if (refusal !== null) return []
  const steps: MessageEffortStep[] = []
  let standing = sessionEffort
  rows.forEach((row, after) => {
    if (row.replyEffort === undefined || row.replyEffort === standing) return
    standing = row.replyEffort
    steps.push({ after, effort: row.replyEffort })
  })
  return steps
}

export function messageEffortRow(effort: EffortLevel): { role: 'system'; content: []; output_config: { effort: EffortLevel } } {
  return { role: 'system', content: [], output_config: { effort } }
}

export function withMessageEffort<Row>(rows: readonly Row[], steps: readonly MessageEffortStep[], rowOf: (effort: EffortLevel) => Row): readonly Row[] {
  if (steps.length === 0) return rows
  const out: Row[] = []
  rows.forEach((row, index) => {
    out.push(row)
    for (const step of steps) if (step.after === index) out.push(rowOf(step.effort))
  })
  return out
}

function isMessageEffortRow(row: unknown): boolean {
  return typeof row === 'object' && row !== null && 'role' in row && row.role === 'system' && 'output_config' in row
}

export function noteMessageEffortRefusal(messages: readonly unknown[], error: unknown): void {
  if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 400) return
  if (messages.some(isMessageEffortRow)) refusal = error
}

export function messageEffortRefusedBy(error: unknown): boolean {
  return refusal !== null && refusal === error
}
