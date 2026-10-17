export const RESULT_ROOM_LINE_SHARE = 0.8
export const RESULT_ROOM_TURN_CEILING_TOKENS = 60_000
export const RESULT_ROOM_FLOOR_MAX_TOKENS = 4_000
export const RESULT_ROOM_FLOOR_MIN_TOKENS = 1_000
export const RESULT_ROOM_FLOOR_DIVISOR = 8
export const RESULT_ROOM_WORDS = 'the context is near its fold'

export type ResultRoomFacts = { window: number; blockingLimit: number; foldLine: number; gauge: number }

export type ResultRoomBudget =
  | { awake: false; line: number; gauge: number }
  | { awake: true; line: number; gauge: number; room: number; ceiling: number; floor: number }

export function resultRoomBudget(facts: ResultRoomFacts): ResultRoomBudget {
  const line = Math.min(facts.foldLine, Math.floor(facts.window * RESULT_ROOM_LINE_SHARE))
  if (!(facts.gauge >= line)) return { awake: false, line, gauge: facts.gauge }
  const room = Math.max(0, facts.blockingLimit - facts.gauge)
  const floor = Math.min(RESULT_ROOM_FLOOR_MAX_TOKENS, Math.max(RESULT_ROOM_FLOOR_MIN_TOKENS, Math.floor(facts.blockingLimit / RESULT_ROOM_FLOOR_DIVISOR)))
  const ceiling = Math.min(RESULT_ROOM_TURN_CEILING_TOKENS, Math.max(floor, room))
  return { awake: true, line, gauge: facts.gauge, room, ceiling, floor }
}

export type ResultRoomTake = { id: string; granted: number; landed: number }

export type ResultRoom = {
  readonly budget: Extract<ResultRoomBudget, { awake: true }>
  remaining(): number
  reserve(id: string, wanted: number): number
  allowance(id: string): number
  settle(id: string, landed: number): void
  takes(): ResultRoomTake[]
}

export function createResultRoom(budget: Extract<ResultRoomBudget, { awake: true }>): ResultRoom {
  let remaining = budget.ceiling
  const grants = new Map<string, number>()
  const takes: ResultRoomTake[] = []
  const share = (): number => Math.max(budget.floor, remaining)
  return {
    budget,
    remaining: () => remaining,
    reserve(id, wanted) {
      const granted = Math.max(0, Math.min(wanted, share()))
      remaining = Math.max(0, remaining - granted)
      grants.set(id, granted)
      return granted
    },
    allowance(id) {
      const granted = grants.get(id)
      return granted !== undefined ? Math.max(budget.floor, granted) : share()
    },
    settle(id, landed) {
      const granted = grants.get(id) ?? 0
      grants.delete(id)
      remaining = Math.max(0, remaining + granted - Math.max(0, landed))
      takes.push({ id, granted, landed })
    },
    takes: () => [...takes],
  }
}

const rooms = new WeakMap<object, ResultRoom>()

export function bindResultRoom(room: ResultRoom, anchors: readonly unknown[]): void {
  for (const anchor of anchors) {
    if (typeof anchor === 'object' && anchor !== null) rooms.set(anchor, room)
  }
}

export function resultRoomFor(anchor: unknown): ResultRoom | null {
  if (typeof anchor !== 'object' || anchor === null) return null
  return rooms.get(anchor) ?? null
}

export function tokensOfResultText(text: string): number {
  return Math.ceil(text.length / 4)
}
