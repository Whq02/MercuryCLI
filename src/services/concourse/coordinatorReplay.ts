
import type { CoordinatorConversationEntryV1 } from './coordinatorConversation.js'
import type { ManagerAskV1, ManagerPlanV1 } from './managerMode.js'
import { ageLabelOf } from './concourseSnapshot.js'

export interface CoordinatorReplayRowV1 {
  role: 'operator' | 'coordinator' | 'harness'
  text: string
  age?: string
  settled?: true
  receipts?: ReadonlyArray<{ verb: string; outcome: string; label: string }>
}

export const REPLAY_TAIL = 12
export const REPLAY_CLIP = 600
export const REPLAY_SUMMARY_CLIP = 4400
export const REPLAY_AGE_FLOOR_MS = 30 * 60_000

export function renderPlanForReplay(plan: ManagerPlanV1): string {
  const lanes = plan.lanes
    .map(
      (lane, i) =>
        `lane ${i + 1} · ${lane.title}\n  scope: ${lane.scope}\n  delivers: ${lane.deliverables}\n  territory: ${lane.territory}`,
    )
    .join('\n')
  const waiting = plan.laneWaiting !== undefined && plan.laneWaiting.length > 0 ? `\nwaiting lanes: ${plan.laneWaiting.map(i => i + 1).join(', ')}` : ''
  return `<plan state="${plan.state}" supervision="${plan.supervision}">\ngoal: ${plan.goal}\n${lanes}${
    plan.seats !== undefined ? `\nseats: ${plan.seats}` : ''
  }${waiting}\n</plan>`
}

export function renderAskForReplay(ask: ManagerAskV1): string {
  if (ask.options.length === 0) return ''
  return `<ask${ask.index !== undefined ? ` question="${ask.index}"` : ''}>\n${ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n</ask>`
}

const cardBearing = (e: CoordinatorConversationEntryV1): boolean => e.plan !== undefined || e.ask !== undefined

export function buildCoordinatorReplay(
  entries: readonly CoordinatorConversationEntryV1[],
  nowMs: number,
): CoordinatorReplayRowV1[] {
  const settledMessageIds = new Set<string>()
  for (const e of entries) {
    if (e.harness === true && !cardBearing(e) && e.id.startsWith('co:')) settledMessageIds.add(e.id.slice(3))
  }
  const rows: CoordinatorReplayRowV1[] = []
  const tail = entries.slice(-REPLAY_TAIL)
  const newestSummary = [...entries].reverse().find(e => e.summary === true)
  const replayed = newestSummary !== undefined && !tail.includes(newestSummary) ? [newestSummary, ...tail] : tail
  for (const e of replayed) {
    const receipts =
      e.receipts !== undefined && e.receipts.length > 0
        ? e.receipts.slice(0, 12).map(r => ({ verb: r.verb, outcome: r.outcome, label: r.label.slice(0, 240) }))
        : undefined
    if (e.text.length === 0 && receipts === undefined && !cardBearing(e)) continue
    const age =
      Number.isFinite(e.ts) && nowMs - e.ts > REPLAY_AGE_FLOOR_MS
        ? `${ageLabelOf(nowMs, e.ts)} earlier`
        : undefined
    const settled =
      e.role === 'operator' && e.id.startsWith('op:') && settledMessageIds.has(e.id.slice(3))
        ? (true as const)
        : undefined
    const cards = [
      e.ask !== undefined ? renderAskForReplay(e.ask) : '',
      e.plan !== undefined ? renderPlanForReplay(e.plan) : '',
    ].filter(s => s.length > 0)
    const text = [e.text.slice(0, e.summary === true ? REPLAY_SUMMARY_CLIP : REPLAY_CLIP), ...cards]
      .filter(s => s.length > 0)
      .join('\n\n')
    rows.push({
      role: e.harness === true && !cardBearing(e) ? 'harness' : e.role,
      text,
      ...(age !== undefined ? { age } : {}),
      ...(settled !== undefined ? { settled } : {}),
      ...(receipts !== undefined ? { receipts } : {}),
    })
  }
  return rows
}
