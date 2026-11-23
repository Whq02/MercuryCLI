type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = {
  min: number
  max: number
  wrapMax?: number
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, wrapMax: 0 },
]

function parseIntStrict(text: string): number | null {
  if (!/^\d+$/.test(text)) return null
  return Number(text)
}

function expandField(field: string, range: FieldRange): number[] | null {
  if (field === '') return null
  const values = new Set<number>()
  const addValue = (v: number): void => {
    values.add(range.wrapMax !== undefined && v === range.max ? range.wrapMax : v)
  }
  const starEnd = range.wrapMax !== undefined ? range.max - 1 : range.max
  for (const item of field.split(',')) {
    if (item === '') return null
    const slashParts = item.split('/')
    if (slashParts.length > 2) return null
    let step = 1
    if (slashParts.length === 2) {
      const parsedStep = parseIntStrict(slashParts[1]!)
      if (parsedStep === null || parsedStep <= 0) return null
      step = parsedStep
    }
    const base = slashParts[0]!
    if (base === '*') {
      for (let v = range.min; v <= starEnd; v += step) addValue(v)
    } else if (base.includes('-')) {
      const dashParts = base.split('-')
      if (dashParts.length !== 2) return null
      const start = parseIntStrict(dashParts[0]!)
      const end = parseIntStrict(dashParts[1]!)
      if (start === null || end === null || start < range.min || end > range.max || start > end) return null
      for (let v = start; v <= end; v += step) addValue(v)
    } else {
      const n = parseIntStrict(base)
      if (n === null || n < range.min || n > range.max) return null
      if (slashParts.length === 2) {
        if (n > starEnd) addValue(n)
        else for (let v = n; v <= starEnd; v += step) addValue(v)
      } else {
        addValue(n)
      }
    }
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
  const minute = expandField(parts[0]!, FIELD_RANGES[0]!)
  const hour = expandField(parts[1]!, FIELD_RANGES[1]!)
  const dayOfMonth = expandField(parts[2]!, FIELD_RANGES[2]!)
  const month = expandField(parts[3]!, FIELD_RANGES[3]!)
  const dayOfWeek = expandField(parts[4]!, FIELD_RANGES[4]!)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return { minute, hour, dayOfMonth, month, dayOfWeek }
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

function formatTime12(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`
}

export function cronToHuman(cron: string): string {
  const trimmed = cron.trim()
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return cron
  const fields = parseCronExpression(trimmed)
  if (fields === null) return cron
  const [minPart, hourPart, domPart, monthPart, dowPart] = parts as [string, string, string, string, string]
  if (minPart === '*' && hourPart === '*' && domPart === '*' && monthPart === '*' && dowPart === '*') {
    return 'Every minute'
  }
  if (minPart.startsWith('*/') && hourPart === '*' && domPart === '*' && monthPart === '*' && dowPart === '*') {
    const step = parseIntStrict(minPart.slice(2))
    if (step !== null && step > 0) return step === 1 ? 'Every minute' : `Every ${step} minutes`
  }
  const fixedMin = parseIntStrict(minPart)
  if (fixedMin !== null && hourPart === '*' && domPart === '*' && monthPart === '*' && dowPart === '*') {
    return fixedMin === 0 ? 'Every hour' : `Every hour at :${String(fixedMin).padStart(2, '0')}`
  }
  if (fixedMin !== null && hourPart.startsWith('*/') && domPart === '*' && monthPart === '*' && dowPart === '*') {
    const step = parseIntStrict(hourPart.slice(2))
    if (step !== null && step > 0) {
      const base = step === 1 ? 'Every hour' : `Every ${step} hours`
      return fixedMin === 0 ? base : `${base} at :${String(fixedMin).padStart(2, '0')}`
    }
  }
  const fixedHour = parseIntStrict(hourPart)
  if (fixedMin !== null && fixedHour !== null) {
    const time = formatTime12(fixedHour, fixedMin)
    if (domPart === '*' && monthPart === '*' && dowPart === '*') {
      return `Every day at ${time}`
    }
    if (domPart === '*' && monthPart === '*' && dowPart !== '*') {
      const dow = fields.dayOfWeek
      if (dow.length === 5 && dow[0] === 1 && dow[4] === 5) return `Weekdays at ${time}`
      if (dow.length === 2 && dow[0] === 0 && dow[1] === 6) return `Weekends at ${time}`
      const names = dow.map(d => WEEKDAY_NAMES[d]!).join(', ')
      return `Every ${names} at ${time}`
    }
    if (domPart !== '*' && monthPart !== '*' && dowPart === '*') {
      const fixedDom = parseIntStrict(domPart)
      const fixedMonth = parseIntStrict(monthPart)
      if (fixedDom !== null && fixedMonth !== null) {
        return `At ${time} on ${fixedDom} ${MONTH_NAMES[fixedMonth - 1]!}`
      }
    }
    if (domPart !== '*' && monthPart === '*' && dowPart === '*') {
      const fixedDom = parseIntStrict(domPart)
      if (fixedDom !== null) {
        return `Day ${fixedDom} of every month at ${time}`
      }
    }
  }
  return cron
}
