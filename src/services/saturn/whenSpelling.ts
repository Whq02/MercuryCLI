// ============================================================================
//  services/saturn/whenSpelling — THE OPERATOR-PHRASE COMPILER (SATURN's
//  fork (v) as ruled: the spelling grammar rides `when.spelling` verbatim;
//  the compile targets are 'at' / 'every'+cron; the operator-phrase compiler
//  is the SCREEN's form seam — this module IS that seam).
//
//  The form compiles what the operator typed through here and shows THIS
//  module's errors; the phrase itself is stored VERBATIM on the schedule
//  (`when.spelling`) and echoed by describeWhen on every surface — the
//  compiled cron/atMs is the machine's fact, the spelling is the operator's.
//
//  PINNED-SPELLING-WINS (the lead's D edge): the landed substrate's own
//  exampled phrases compile exactly as landed — 'every day 09:00' →
//  '0 9 * * *' (prove-saturn-core §W), 'in a minute' → a one-minute 'at'
//  (§F's fixture), cronToHuman's display forms ('Every minute', 'Every
//  hour at :07', 'Every 5 minutes', 'Every day at …') round-trip back
//  through this grammar, and a raw 5-field cron expression passes verbatim
//  (the model tools' own vocabulary). Everything else is additive.
//
//  Pure and clock-injected (nowMs) — the provers freeze the clock; nothing
//  here reads Date.now(), the environment, or a file. Times read in the
//  operator's LOCAL timezone (the tool doctrine's own law). Errors are
//  typed sentences that name a working form; the compiler never throws.
// ============================================================================
import { parseCronExpression } from '../../utils/cron.js'
import { SATURN_SPELLING_CAP, type SaturnWhenV1 } from '../../daemon/saturn.js'

export type WhenSpellingCompile =
  | { ok: true; when: SaturnWhenV1 }
  | { ok: false; reason: string }

/** The teaching set the form's hint line and the prover share — one example
 *  per arm of the grammar, each of which compiles green below. */
export const WHEN_SPELLING_EXAMPLES: readonly string[] = [
  '6am',
  '18:30',
  'tomorrow 07:30',
  'in 20m',
  'every 5 minutes',
  'every hour at :07',
  'every day 09:00',
  'weekdays 9am',
  'every mon,fri 17:00',
  '0 9 * * 1-5',
]

const FORMS_LINE =
  "a time ('6am', '18:30'), 'tomorrow <time>', 'in <n>m/h/d', 'every <n> minutes', 'hourly', 'every day <time>', 'weekdays <time>', 'every mon,fri <time>', or a 5-field cron"

const DAY_NUMBERS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}

/** One local-clock time of day, parsed from the operator's words: '6am',
 *  '6:30pm', '18:30', '07:05', 'noon', 'midnight'. null = not a time. */
export function parseTimeOfDay(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim().toLowerCase()
  if (s === 'noon') return { hour: 12, minute: 0 }
  if (s === 'midnight') return { hour: 0, minute: 0 }
  const ampm = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/.exec(s)
  if (ampm) {
    const h = Number(ampm[1])
    if (h < 1 || h > 12) return null
    const minute = ampm[2] !== undefined ? Number(ampm[2]) : 0
    const hour = ampm[3] === 'pm' ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h
    return { hour, minute }
  }
  const h24 = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (h24) return { hour: Number(h24[1]), minute: Number(h24[2]) }
  return null
}

/** Epoch ms of the next LOCAL occurrence of a time of day strictly after
 *  `fromMs` (today when still ahead, else tomorrow); `dayOffset` pushes the
 *  base day first ('tomorrow 07:30' passes 1 and lands there even when the
 *  time would still fit today). */
function nextLocalOccurrence(fromMs: number, hour: number, minute: number, dayOffset: 0 | 1): number {
  const base = new Date(fromMs)
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0)
  if (dayOffset === 0 && candidate.getTime() <= fromMs) {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime()
  }
  return candidate.getTime()
}

function ok(when: SaturnWhenV1): WhenSpellingCompile {
  return { ok: true, when }
}
function no(reason: string): WhenSpellingCompile {
  return { ok: false, reason }
}
function every(cron: string, spelling: string): WhenSpellingCompile {
  // Impossible for the grammar's own constructions; the guard keeps the
  // compiler total if the cron helpers ever narrow.
  if (parseCronExpression(cron) === null) return no(`'${spelling}' compiled to an expression the cron parser refuses ('${cron}')`)
  return ok({ kind: 'every', cron, spelling })
}

/** A delay word: '20m' · '2h' · '1d' · '30s' · 'a minute' · 'an hour' ·
 *  'a day'. null = not a delay. */
function parseDelayMs(s: string): number | null {
  if (s === 'a minute' || s === 'one minute') return 60_000
  if (s === 'an hour' || s === 'one hour') return 3_600_000
  if (s === 'a day' || s === 'one day') return 86_400_000
  const m = /^(\d{1,5})\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (n === 0) return null
  const unit = m[2]![0]
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
}

/** '<time>' with an optional leading 'at' — 'at 9am', '09:00'. */
function timeOfClause(clause: string): { hour: number; minute: number } | null {
  return parseTimeOfDay(clause.replace(/^at\s+/, ''))
}

/**
 * The compiler: one operator phrase → a validated SaturnWhenV1 with the
 * phrase stored verbatim, or a typed refusal in this module's own words.
 */
export function compileWhenSpelling(raw: string, nowMs: number): WhenSpellingCompile {
  const spelling = raw.trim()
  if (spelling.length === 0) return no(`say when — ${FORMS_LINE}`)
  if (spelling.length > SATURN_SPELLING_CAP) {
    return no(`a schedule spelling stays under ${SATURN_SPELLING_CAP} characters`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(spelling)) return no('a schedule spelling is one plain line')
  const s = spelling.toLowerCase().replace(/\s+/g, ' ')

  // ── a raw 5-field cron expression passes verbatim (the tools' own word) ──
  if (s.split(' ').length === 5 && parseCronExpression(spelling) !== null) {
    return ok({ kind: 'every', cron: spelling.replace(/\s+/g, ' '), spelling })
  }

  // ── one-shots: 'in <delay>' ─────────────────────────────────────────────
  const inArm = /^in (.+)$/.exec(s)
  if (inArm) {
    const delay = parseDelayMs(inArm[1]!)
    if (delay === null) return no(`'in ${inArm[1]!}' is not a delay — 'in 20m', 'in 2h', 'in a minute'`)
    return ok({ kind: 'at', atMs: nowMs + delay, spelling })
  }

  // ── one-shots: 'tomorrow <time>' ('tomorrow morning' = the landed 9am) ──
  const tomorrowArm = /^tomorrow(?: (.+))?$/.exec(s)
  if (tomorrowArm) {
    const clause = tomorrowArm[1]
    const time = clause === undefined || clause === 'morning' ? { hour: 9, minute: 0 } : timeOfClause(clause)
    if (clause !== undefined && clause !== 'morning' && time === null) {
      return no(`'${clause}' is not a time — 'tomorrow 07:30', 'tomorrow 6am', 'tomorrow morning'`)
    }
    return ok({ kind: 'at', atMs: nextLocalOccurrence(nowMs, time!.hour, time!.minute, 1), spelling })
  }

  // ── recurring: 'hourly' / 'every …' / 'daily …' / 'weekdays …' ──────────
  if (s === 'hourly' || s === 'every hour') return every('0 * * * *', spelling)
  if (s === 'every minute') return every('* * * * *', spelling)
  const hourAt = /^every hour at :?([0-5]?\d)$/.exec(s)
  if (hourAt) return every(`${Number(hourAt[1])} * * * *`, spelling)
  const everyN = /^every (\d{1,2}) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(s)
  if (everyN) {
    const n = Number(everyN[1])
    const hours = everyN[2]![0] === 'h'
    if (n === 0) return no(`'${spelling}' names a zero interval`)
    if (hours && n > 23) return no(`'every ${n} hours' does not fit a day — 23 is the widest hourly step`)
    if (!hours && n > 59) return no(`'every ${n} minutes' does not fit an hour — 59 is the widest minute step; say 'hourly' or wider`)
    if (n === 1) return every(hours ? '0 * * * *' : '* * * * *', spelling)
    return every(hours ? `0 */${n} * * *` : `*/${n} * * * *`, spelling)
  }
  const dailyArm = /^(?:every day|daily)(?: (.+))?$/.exec(s)
  if (dailyArm) {
    if (dailyArm[1] === undefined) return no(`say the time too — 'every day 09:00', 'daily 6pm'`)
    const time = timeOfClause(dailyArm[1])
    if (time === null) return no(`'${dailyArm[1]}' is not a time — 'every day 09:00', 'daily 6pm'`)
    return every(`${time.minute} ${time.hour} * * *`, spelling)
  }
  const weekArm = /^(?:every )?(weekdays?|weekends?)(?: (.+))?$/.exec(s)
  if (weekArm) {
    const dow = weekArm[1]!.startsWith('weekday') ? '1-5' : '0,6'
    if (weekArm[2] === undefined) return no(`say the time too — 'weekdays 9am', 'weekends 10:00'`)
    const time = timeOfClause(weekArm[2])
    if (time === null) return no(`'${weekArm[2]}' is not a time — 'weekdays 9am', 'weekends 10:00'`)
    return every(`${time.minute} ${time.hour} * * ${dow}`, spelling)
  }
  const daysArm = /^every ([a-z, ]+?) (.+)$/.exec(s)
  if (daysArm) {
    const names = daysArm[1]!.split(',').map(d => d.trim()).filter(d => d.length > 0)
    const nums = names.map(d => DAY_NUMBERS[d])
    if (names.length > 0 && nums.every((n): n is number => n !== undefined)) {
      const time = timeOfClause(daysArm[2]!)
      if (time === null) return no(`'${daysArm[2]!}' is not a time — 'every monday 9am', 'every mon,fri 17:00'`)
      const dow = [...new Set(nums)].sort((a, b) => a - b).join(',')
      return every(`${time.minute} ${time.hour} * * ${dow}`, spelling)
    }
    // Not day names — fall through to the time arm's refusal below.
  }

  // ── one-shots: a bare time of day ('6am', 'at 18:30', 'noon') ───────────
  const time = timeOfClause(s)
  if (time !== null) return ok({ kind: 'at', atMs: nextLocalOccurrence(nowMs, time.hour, time.minute, 0), spelling })

  return no(`'${spelling}' is not a schedule spelling — ${FORMS_LINE}`)
}
