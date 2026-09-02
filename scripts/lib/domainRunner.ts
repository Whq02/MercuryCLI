
import { makeNormalizer } from './goldenReplay.ts'

export interface DeterministicClock {
  now(): number
  isoNow(): string
  advance(ms: number): void
}

export function makeClock(
  startIso = '2026-01-01T00:00:00.000Z',
  stepPerRead = 0,
): DeterministicClock {
  let t = Date.parse(startIso)
  return {
    now(): number {
      const v = t
      t += stepPerRead
      return v
    },
    isoNow(): string {
      const v = t
      t += stepPerRead
      return new Date(v).toISOString()
    },
    advance(ms: number): void {
      t += ms
    },
  }
}

export interface DeterministicIds {
  next(kind?: string): string
}

export function makeIds(prefix = 'fix'): DeterministicIds {
  const counters = new Map<string, number>()
  return {
    next(kind = 'id'): string {
      const n = (counters.get(kind) ?? 0) + 1
      counters.set(kind, n)
      return `${prefix}-${kind}-${n}`
    },
  }
}

export interface RecordedEvent {
  seq: number
  owner: string
  op: string
  state: string
  at: number
  payload?: unknown
}

export class EventRecorder {
  private events: RecordedEvent[] = []
  private seq = 0
  constructor(private clock: DeterministicClock = makeClock()) {}

  emit(owner: string, op: string, state: string, payload?: unknown): RecordedEvent {
    const ev: RecordedEvent = {
      seq: ++this.seq,
      owner,
      op,
      state,
      at: this.clock.now(),
      ...(payload === undefined ? {} : { payload }),
    }
    this.events.push(ev)
    return ev
  }

  log(): RecordedEvent[] {
    return [...this.events]
  }

  snapshot(): unknown {
    return makeNormalizer()(this.events)
  }
}

export function diffEventLogs(golden: unknown, current: unknown): string[] {
  const problems: string[] = []
  const g = Array.isArray(golden) ? golden : []
  const c = Array.isArray(current) ? current : []
  if (!Array.isArray(golden) || !Array.isArray(current)) {
    return [`non-array event log: golden=${typeof golden} current=${typeof current}`]
  }
  if (g.length !== c.length) {
    problems.push(`event count diverged: golden=${g.length} current=${c.length}`)
  }
  const n = Math.min(g.length, c.length)
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(g[i])
    const b = JSON.stringify(c[i])
    if (a !== b) {
      let j = 0
      while (j < Math.min(a.length, b.length) && a[j] === b[j]) j++
      problems.push(
        `event[${i}] diverged:\n      golden:  …${a.slice(Math.max(0, j - 60), j + 90)}…\n      current: …${b.slice(Math.max(0, j - 60), j + 90)}…`,
      )
      break
    }
  }
  if (g.length !== c.length && n > 0 && problems.length === 1) {
    const extra = (g.length > c.length ? g : c)[n] as unknown
    problems.push(
      `first unmatched event (${g.length > c.length ? 'golden' : 'current'}[${n}]): ${JSON.stringify(extra).slice(0, 160)}`,
    )
  }
  return problems
}
