import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

type CronFields = Unbuilt

type FieldRange = Unbuilt

const FIELD_RANGES: FieldRange[] = unbuilt('src/utils/cron.ts:12')

function parseIntStrict(text: string): number | null {
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

function expandField(field: string, range: FieldRange): number[] | null {
  return notBuilt('src/utils/cron.ts:25')
}

export function cronFieldProblem(expr: string): { kind: 'count'; n: number } | { kind: 'field'; index: number; part: string } | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return { kind: 'count', n: parts.length }
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if (expandField(part, FIELD_RANGES[index]!) === null) return { kind: 'field', index, part }
  }
  return null
}

export function parseCronExpression(expr: string): CronFields | null {
  return notBuilt('src/utils/cron.ts:75')
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

function utcOffsetMs(at: number): number {
  return -new Date(at).getTimezoneOffset() * MINUTE_MS
}

function repeatsEarlierWallClock(at: number): boolean {
  const offset = utcOffsetMs(at)
  const earlier = utcOffsetMs(at - 3 * HOUR_MS)
  return earlier > offset && utcOffsetMs(at - (earlier - offset)) === earlier
}

function forwardFrom(at: number, candidate: number): number {
  return candidate > at ? candidate : at + HOUR_MS
}

export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const domConstrained = fields.dayOfMonth.length < 31
  const dowConstrained = fields.dayOfWeek.length < 7
  const dayMatches = (dayOfMonth: number, dayOfWeek: number): boolean => {
    const domOk = fields.dayOfMonth.includes(dayOfMonth)
    const dowOk = fields.dayOfWeek.includes(dayOfWeek)
    if (domConstrained && dowConstrained) return domOk || dowOk
    if (domConstrained) return domOk
    if (dowConstrained) return dowOk
    return true
  }
  const wallClockMatches = (wallMs: number): boolean => {
    const wall = new Date(wallMs)
    return fields.month.includes(wall.getUTCMonth() + 1) && dayMatches(wall.getUTCDate(), wall.getUTCDay()) && fields.hour.includes(wall.getUTCHours()) && fields.minute.includes(wall.getUTCMinutes())
  }
  const hourFixed = fields.hour.length < 24
  let previousOffset = utcOffsetMs(from.getTime())
  let at = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const bound = at + 366 * 24 * HOUR_MS
  while (at <= bound) {
    const offset = utcOffsetMs(at)
    if (hourFixed && offset > previousOffset) {
      for (let skipped = at + previousOffset; skipped < at + offset; skipped += MINUTE_MS) {
        if (wallClockMatches(skipped)) return new Date(at)
      }
    }
    previousOffset = offset
    const local = new Date(at)
    if (!fields.month.includes(local.getMonth() + 1)) {
      at = forwardFrom(at, new Date(local.getFullYear(), local.getMonth() + 1, 1, 0, 0, 0, 0).getTime())
      continue
    }
    if (!dayMatches(local.getDate(), local.getDay())) {
      at = forwardFrom(at, new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1, 0, 0, 0, 0).getTime())
      continue
    }
    if (!fields.hour.includes(local.getHours()) || (hourFixed && repeatsEarlierWallClock(at))) {
      at += HOUR_MS - local.getMinutes() * MINUTE_MS
      continue
    }
    if (!fields.minute.includes(local.getMinutes())) {
      at += MINUTE_MS
      continue
    }
    return local
  }
  return null
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

export function cronToHuman(cron: string): string {
  return notBuilt('src/utils/cron.ts:178')
}
