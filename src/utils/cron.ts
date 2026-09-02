
export type CronFields = {
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

export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const current = new Date(from)
  current.setSeconds(0, 0)
  current.setMinutes(current.getMinutes() + 1)

  const domConstrained = fields.dayOfMonth.length < 31
  const dowConstrained = fields.dayOfWeek.length < 7
  const dayMatches = (date: Date): boolean => {
    const domOk = fields.dayOfMonth.includes(date.getDate())
    const dowOk = fields.dayOfWeek.includes(date.getDay())
    if (domConstrained && dowConstrained) return domOk || dowOk
    if (domConstrained) return domOk
    if (dowConstrained) return dowOk
    return true
  }

  const bound = current.getTime() + 366 * 24 * 60 * 60 * 1000
  while (current.getTime() <= bound) {
    if (!fields.month.includes(current.getMonth() + 1)) {
      current.setMonth(current.getMonth() + 1, 1)
      current.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(current)) {
      current.setDate(current.getDate() + 1)
      current.setHours(0, 0, 0, 0)
      continue
    }
    if (!fields.hour.includes(current.getHours())) {
      current.setHours(current.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!fields.minute.includes(current.getMinutes())) {
      current.setMinutes(current.getMinutes() + 1)
      continue
    }
    return current
  }
  return null
}

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
  return cron
}
