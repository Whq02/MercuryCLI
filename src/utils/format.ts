
import { getRelativeTimeFormat, getTimeZone } from './intl.js'

export {
  truncate,
  truncatePathMiddle,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from './truncate.js'


export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const scaled = (value: number, suffix: string): string =>
    `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`
  if (bytes < 1024 * 1024) return scaled(bytes / 1024, 'KB')
  if (bytes < 1024 * 1024 * 1024) return scaled(bytes / (1024 * 1024), 'MB')
  return scaled(bytes / (1024 * 1024 * 1024), 'GB')
}


export function formatSecondsShort(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms === 0) return '0s'
  if (ms < 1) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`

  let seconds = Math.round((ms % 60_000) / 1000)
  let minutes = Math.floor(ms / 60_000) % 60
  let hours = Math.floor(ms / 3_600_000) % 24
  let days = Math.floor(ms / 86_400_000)
  if (seconds === 60) {
    seconds = 0
    minutes += 1
  }
  if (minutes === 60) {
    minutes = 0
    hours += 1
  }
  if (hours === 24) {
    hours = 0
    days += 1
  }

  let parts: Array<{ value: number; suffix: string }>
  if (days > 0) {
    parts = [
      { value: days, suffix: 'd' },
      { value: hours, suffix: 'h' },
      { value: minutes, suffix: 'm' },
    ]
  } else if (hours > 0) {
    parts = [
      { value: hours, suffix: 'h' },
      { value: minutes, suffix: 'm' },
      { value: seconds, suffix: 's' },
    ]
  } else {
    parts = [
      { value: minutes, suffix: 'm' },
      { value: seconds, suffix: 's' },
    ]
  }

  if (options?.mostSignificantOnly) {
    const significant = parts.find(p => p.value > 0) ?? parts[0]!
    return `${significant.value}${significant.suffix}`
  }
  if (options?.hideTrailingZeros) {
    while (parts.length > 1 && parts[parts.length - 1]!.value === 0) parts.pop()
  }
  return parts.map(p => `${p.value}${p.suffix}`).join(' ')
}

export function formatBarElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (total < 3600) return `${Math.floor(total / 60)}m${pad(total % 60)}s`
  if (total < 86_400) {
    return `${Math.floor(total / 3600)}h${pad(Math.floor((total % 3600) / 60))}m`
  }
  return `${Math.floor(total / 86_400)}d${pad(Math.floor((total % 86_400) / 3600))}h`
}


const COMPACT_FIXED = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const COMPACT_LOOSE = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatNumber(n: number): string {
  const formatter = Math.abs(n) >= 1000 ? COMPACT_FIXED : COMPACT_LOOSE
  return formatter.format(n).toLowerCase()
}

export function formatTokens(n: number): string {
  return formatNumber(n).replace('.0', '')
}

export function formatTokenEstimate(n: number): string {
  if (n < 20) return '< 20'
  return `~${formatTokens(Math.round(n / 10) * 10)}`
}


const RELATIVE_UNITS: Array<{
  unit: Intl.RelativeTimeFormatUnit
  seconds: number
  narrow: string
}> = [
  { unit: 'year', seconds: 31_536_000, narrow: 'y' },
  { unit: 'month', seconds: 2_592_000, narrow: 'mo' },
  { unit: 'week', seconds: 604_800, narrow: 'w' },
  { unit: 'day', seconds: 86_400, narrow: 'd' },
  { unit: 'hour', seconds: 3600, narrow: 'h' },
  { unit: 'minute', seconds: 60, narrow: 'm' },
  { unit: 'second', seconds: 1, narrow: 's' },
]

export function formatRelativeTime(
  date: Date,
  options?: {
    style?: 'long' | 'short' | 'narrow'
    numeric?: 'always' | 'auto'
    now?: Date
  },
): string {
  const style = options?.style ?? 'narrow'
  const numeric = options?.numeric ?? 'always'
  const now = options?.now ?? new Date()
  const diff = Math.trunc((date.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(diff)

  if (abs < 1) {
    if (style === 'narrow') return diff > 0 ? 'in 0s' : '0s ago'
    return getRelativeTimeFormat(style, numeric).format(diff, 'second')
  }

  for (const { unit, seconds, narrow } of RELATIVE_UNITS) {
    if (abs >= seconds) {
      const value = Math.trunc(abs / seconds)
      if (style === 'narrow') {
        return diff < 0 ? `${value}${narrow} ago` : `in ${value}${narrow}`
      }
      return getRelativeTimeFormat('long', numeric).format(diff < 0 ? -value : value, unit)
    }
  }
  return style === 'narrow' ? '0s ago' : getRelativeTimeFormat(style, numeric).format(0, 'second')
}

export function formatRelativeTimeAgo(
  date: Date,
  options?: {
    style?: 'long' | 'short' | 'narrow'
    numeric?: 'always' | 'auto'
    now?: Date
  },
): string {
  const now = options?.now ?? new Date()
  if (date.getTime() > now.getTime()) return formatRelativeTime(date, options)
  return formatRelativeTime(date, { ...options, numeric: 'always' })
}


export function formatLogMetadata(log: {
  modified: Date
  messageCount?: number
  fileSize?: number
  gitBranch?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prRepository?: string
  endedOnError?: boolean
}): string {
  const parts: string[] = []
  parts.push(formatRelativeTimeAgo(log.modified, { style: 'short' }))
  if (log.gitBranch) parts.push(log.gitBranch)
  if (log.fileSize !== undefined) {
    parts.push(formatFileSize(log.fileSize))
  } else if (log.messageCount !== undefined) {
    parts.push(`${log.messageCount} messages`)
  }
  if (log.tag) parts.push(`#${log.tag}`)
  if (log.agentSetting) parts.push(`@${log.agentSetting}`)
  if (log.prNumber !== undefined) {
    parts.push(log.prRepository ? `${log.prRepository}#${log.prNumber}` : `#${log.prNumber}`)
  }
  if (log.endedOnError) parts.push('✕ ended on error')
  return parts.join(' · ')
}


function timeZoneAbbreviation(date: Date): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone: getTimeZone(),
    timeZoneName: 'short',
  }).formatToParts(date)
  return parts.find(p => p.type === 'timeZoneName')?.value ?? getTimeZone()
}

function foldMeridiem(text: string): string {
  return text.replace(/\s*(AM|PM)/, (_, ap: string) => ap.toLowerCase())
}

export function formatResetTime(
  timestampSeconds: number | undefined,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string | undefined {
  if (!timestampSeconds) return undefined
  const date = new Date(timestampSeconds * 1000)
  const now = new Date()
  const withinDay = date.getTime() - now.getTime() <= 24 * 3600 * 1000
  const minuteVisible = date.getMinutes() !== 0

  let rendered: string
  if (withinDay) {
    rendered = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      ...(minuteVisible ? { minute: '2-digit' } : {}),
      hour12: true,
    }).format(date)
  } else {
    rendered = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
      ...(showTime
        ? {
            hour: 'numeric',
            ...(minuteVisible ? { minute: '2-digit' } : {}),
            hour12: true,
          }
        : {}),
    }).format(date)
  }
  rendered = foldMeridiem(rendered)
  if (showTimezone) rendered += ` (${timeZoneAbbreviation(date)})`
  return rendered
}

export function formatResetText(
  resetsAt: string,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string {
  const ms = new Date(resetsAt).getTime()
  const seconds = Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
  return `${formatResetTime(seconds, showTimezone, showTime)}`
}
