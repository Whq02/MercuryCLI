import type { SaturnWhenV1 } from '../../daemon/saturn.js'
import { computeNextCronRun, cronFieldProblem, cronToHuman, parseCronExpression } from '../../utils/cron.js'

export type CreateWhenInput = { cron?: string; at?: string; delayMinutes?: number; recurring?: boolean }
export type CreateTime = { when: SaturnWhenV1; recurring: boolean; humanSchedule: string }
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']
const FIELD_RANGES = ['0 to 59', '0 to 23', '1 to 31', '1 to 12', '0 to 7, 0 and 7 both Sunday']

function parts(ms: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(ms).map(p => [p.type, p.value]))
}

export function createLocalTime(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone)
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`
}

function nowWords(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone)
  return `${p.hour}:${p.minute} ${p.timeZoneName} on ${p.weekday} ${p.day} ${p.month} ${p.year}`
}

function dateWords(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone)
  return `${p.day} ${p.month} ${p.year}`
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const amount = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

export function createUntil(ms: number, now: number): string {
  const diff = ms - now
  if (diff <= 0) return 'due now'
  if (diff < MINUTE) return 'in under a minute'
  const minutes = Math.round(diff / MINUTE)
  if (minutes < 60) return `in ${amount(minutes, 'minute')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `in ${amount(hours, 'hour')}${minutes % 60 ? ` ${amount(minutes % 60, 'minute')}` : ''}`
  return `in ${amount(Math.floor(hours / 24), 'day')} ${amount(hours % 24, 'hour')}`
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 120) return amount(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? amount(hours, 'hour') : amount(Math.floor(hours / 24), 'day')
}

export function resolveCreateTime(input: CreateWhenInput, now: number): CreateTime | string {
  const chosen = (['cron', 'at', 'delayMinutes'] as const).filter(key => input[key] !== undefined)
  if (chosen.length === 0) return 'Say when: pass exactly one of delayMinutes (one run, N minutes from now), at (one run at a local date and time, "YYYY-MM-DDTHH:MM"), or cron (a repeating schedule, e.g. "0 9 * * 1-5"). Nothing was scheduled.'
  if (chosen.length > 1) return `Pass only one of cron, at and delayMinutes; this call has ${chosen.length === 2 ? chosen.join(' and ') : `${chosen.slice(0, -1).join(', ')} and ${chosen.at(-1)}`}. Use cron for a repeating schedule, at or delayMinutes for a single run. Nothing was scheduled.`
  if (input.cron === undefined && input.recurring === true) return 'recurring: true needs cron; at and delayMinutes always schedule a single run. For a repeating schedule pass cron; for a single run leave recurring out. Nothing was scheduled.'
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let atMs: number
  if (input.cron !== undefined) {
    const cron = input.cron
    const problem = cronFieldProblem(cron)
    if (problem?.kind === 'count') return `cron "${cron}" has ${problem.n} fields; it needs exactly 5: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5"). Nothing was scheduled.`
    if (problem?.kind === 'field') return `cron "${cron}": the ${FIELD_NAMES[problem.index]} field "${problem.part}" is not supported. Fields take numbers (${FIELD_NAMES[problem.index]} ${FIELD_RANGES[problem.index]}), *, ranges (1-5), lists (1,15) and steps (*/10, 0-30/5); no names (MON, JAN) and no L, W, # or ?. Nothing was scheduled.`
    const fields = parseCronExpression(cron)!
    const next = computeNextCronRun(fields, new Date(now))
    if (next === null) return `cron "${cron}" matches no date in the next 366 days; check the day-of-month and month fields. Nothing was scheduled.`
    if (input.recurring !== false) {
      const humanSchedule = cronToHuman(cron)
      return { recurring: true, humanSchedule, when: { kind: 'every', cron, spelling: humanSchedule } }
    }
    atMs = next.getTime()
    const tokens = cron.trim().split(/\s+/)
    if ([fields.minute, fields.hour, fields.dayOfMonth, fields.month].every(field => field.length === 1) && tokens[4] === '*') {
      const pinned = new Date(new Date(now).getFullYear(), fields.month[0]! - 1, fields.dayOfMonth[0]!, fields.hour[0]!, fields.minute[0]!)
      if (pinned.getTime() <= now && atMs - now > DAY) {
        const p = parts(pinned.getTime(), timeZone)
        const time = `${p.hour}:${p.minute}`
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
        return `cron "${cron}" with recurring: false pins ${time} on ${p.day} ${p.month}, which has already passed (it is now ${nowWords(now, timeZone)}); its next match would be ${dateWords(atMs, timeZone)}. For a run later today or tomorrow pass delayMinutes or at (e.g. "${localDate(tomorrow.getTime())}T${time}"); to mean ${dateWords(atMs, timeZone)}, pass at: "${localDate(atMs)}T${time}". Nothing was scheduled.`
      }
    }
  } else if (input.delayMinutes !== undefined) {
    atMs = Math.ceil((now + input.delayMinutes * MINUTE) / MINUTE) * MINUTE
  } else {
    const at = input.at!
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(at)
    const invalid = `at "${at}" is not a date and time. Pass the local date and time as "YYYY-MM-DDTHH:MM" (today is ${localDate(now)}), optionally with an offset ("Z" or "+01:00"). For a run N minutes from now, pass delayMinutes. Nothing was scheduled.`
    if (!match) return invalid
    const [y, mo, d, h, mi, s] = match.slice(1, 7).map(v => Number(v ?? 0)) as [number, number, number, number, number, number]
    if (h > 23 || mi > 59 || s > 59) return invalid
    const calendar = new Date(0)
    calendar.setUTCFullYear(y, mo - 1, d)
    calendar.setUTCHours(h, mi, s, 0)
    if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return `at "${at}" is not a real calendar date; check the day and month. Nothing was scheduled.`
    const offset = match[7]
    if (offset) {
      const hours = offset === 'Z' ? 0 : Number(offset.slice(1, 3))
      const minutes = offset === 'Z' ? 0 : Number(offset.slice(4, 6))
      if (hours > 23 || minutes > 59) return invalid
      const delta = (hours * 60 + minutes) * MINUTE * (offset.startsWith('-') ? -1 : 1)
      atMs = calendar.getTime() - delta
    } else {
      const local = new Date(y, mo - 1, d, h, mi, s)
      if (y < 100) local.setFullYear(y)
      if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d || local.getHours() !== h || local.getMinutes() !== mi) return `at "${at}" does not exist in ${timeZone}: the clocks skip that time that night. Pass a time outside the skipped hour, or delayMinutes. Nothing was scheduled.`
      atMs = local.getTime()
    }
    if (atMs < now - MINUTE) return `at "${at}" is ${ago(now - atMs)} in the past (it is now ${nowWords(now, timeZone)}). Pass a future time, or delayMinutes for a run N minutes from now. Nothing was scheduled.`
    if (atMs - now > 366 * DAY) return `at "${at}" is ${Math.floor((atMs - now) / DAY)} days ahead; a single run can be at most 366 days out. Check the year. Nothing was scheduled.`
  }
  const humanSchedule = `once at ${createLocalTime(atMs, timeZone)}`
  return { recurring: false, humanSchedule, when: { kind: 'at', atMs, spelling: humanSchedule } }
}
