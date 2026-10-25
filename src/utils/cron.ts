
type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number; isDayOfWeek?: boolean }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6, isDayOfWeek: true },
]

function parseIntStrict(text: string): number | null {
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

function expandField(field: string, range: FieldRange): number[] | null {
  const values = new Set<number>()
  const maxWithAlias = range.isDayOfWeek ? 7 : range.max
  const addValue = (value: number): void => {
    values.add(range.isDayOfWeek && value === 7 ? 0 : value)
  }
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let v = range.min; v <= range.max; v++) values.add(v)
      continue
    }
    const stepMatch = /^\*\/(\d+)$/.exec(part)
    if (stepMatch) {
      const step = parseIntStrict(stepMatch[1] as string)
      if (step === null || step < 1) return null
      for (let v = range.min; v <= range.max; v += step) values.add(v)
      continue
    }
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (rangeMatch) {
      const start = parseIntStrict(rangeMatch[1] as string)
      const end = parseIntStrict(rangeMatch[2] as string)
      const step = rangeMatch[3] === undefined ? 1 : parseIntStrict(rangeMatch[3] as string)
      if (start === null || end === null || step === null || step < 1) return null
      if (start > end || start < range.min || end > maxWithAlias) return null
      for (let v = start; v <= end; v += step) addValue(v)
      continue
    }
    const bare = parseIntStrict(part)
    if (bare !== null) {
      if (bare < range.min || bare > maxWithAlias) return null
      addValue(bare)
      continue
    }
    return null
  }
  if (values.size === 0) return null
  return [...values].sort((a, b) => a - b)
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
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const field = expandField(parts[i] as string, FIELD_RANGES[i] as FieldRange)
    if (field === null) return null
    expanded.push(field)
  }
  return {
    minute: expanded[0] as number[],
    hour: expanded[1] as number[],
    dayOfMonth: expanded[2] as number[],
    month: expanded[3] as number[],
    dayOfWeek: expanded[4] as number[],
  }
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

function formatLocalTime(hour: number, minute: number): string {
  return new Date(2024, 0, 1, hour, minute).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [minutePart, hourPart, domPart, monthPart, dowPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  const restWild = domPart === '*' && monthPart === '*' && dowPart === '*'

  const minuteStep = /^\*\/(\d+)$/.exec(minutePart)
  if (minuteStep && hourPart === '*' && restWild) {
    const step = Number(minuteStep[1])
    return step === 1 ? 'Every minute' : `Every ${step} minutes`
  }

  const minute = parseIntStrict(minutePart)
  const minuteSuffix =
    minute !== null && minute !== 0 ? ` at :${String(minute).padStart(2, '0')}` : ''

  if (minute !== null && hourPart === '*' && restWild) {
    return minute === 0 ? 'Every hour' : `Every hour${minuteSuffix}`
  }

  const hourStep = /^\*\/(\d+)$/.exec(hourPart)
  if (minute !== null && hourStep && restWild) {
    const step = Number(hourStep[1])
    return step === 1 ? `Every hour${minuteSuffix}` : `Every ${step} hours${minuteSuffix}`
  }

  const hour = parseIntStrict(hourPart)
  if (minute === null || hour === null) return cron
  const time = formatLocalTime(hour, minute)

  if (restWild) {
    return `Every day at ${time}`
  }
  if (domPart === '*' && monthPart === '*' && /^\d$/.test(dowPart)) {
    const dow = Number(dowPart) === 7 ? 0 : Number(dowPart)
    const weekday = WEEKDAY_NAMES[dow] as string
    return `Every ${weekday} at ${time}`
  }
  if (domPart === '*' && monthPart === '*' && dowPart === '1-5') {
    return `Weekdays at ${time}`
  }
  const dom = parseIntStrict(domPart)
  const month = parseIntStrict(monthPart)
  if (dom !== null && month !== null && month >= 1 && month <= 12 && dowPart === '*') {
    return `${time} on ${dom} ${MONTH_NAMES[month - 1]}`
  }
  return cron
}
