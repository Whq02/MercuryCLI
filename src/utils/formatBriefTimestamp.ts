// ============================================================================
//  Age-scaled timestamp label for chat/brief message lines, like a
//  messaging app: today → time; this week → weekday + time; older (or any
//  future date) → weekday, short month, day, time. Locale resolution
//  honours the POSIX environment because the runtime's default-locale path
//  ignores it on some platforms.
// ============================================================================

/** POSIX locale variables in precedence order, converted to a language tag:
 *  the codeset suffix (after a dot) and the modifier (after an at sign) are
 *  stripped and underscores become hyphens. Empty, `C` and `POSIX` mean the
 *  platform default — and so does any tag the platform rejects. */
function resolveBriefLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG
  if (!raw) return undefined
  const tag = raw.split('.')[0]!.split('@')[0]!.replace(/_/g, '-')
  if (tag === '' || tag === 'C' || tag === 'POSIX') return undefined
  try {
    // The platform is the validity oracle; an invalid tag falls back.
    new Intl.DateTimeFormat(tag)
    return tag
  } catch {
    return undefined
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    formatterCache.set(key, formatter)
  }
  return formatter
}

/** Local midnight of a date's calendar day. */
function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatBriefTimestamp(isoString: string, now: Date = new Date()): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  const locale = resolveBriefLocale()
  // Day difference between LOCAL midnights, rounded.
  const dayDiff = Math.round((localMidnight(now) - localMidnight(date)) / 86_400_000)
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  if (dayDiff === 0) {
    return formatterFor(locale, time).format(date)
  }
  if (dayDiff >= 1 && dayDiff <= 6) {
    return formatterFor(locale, { weekday: 'long', ...time }).format(date)
  }
  // Older — and any future date.
  return formatterFor(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...time,
  }).format(date)
}
