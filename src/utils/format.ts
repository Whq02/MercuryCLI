import { getRelativeTimeFormat, getTimeZone } from './intl.js'

export {
  truncate,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from './truncate.js'


export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const power = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3
  const n = (bytes / 1024 ** power).toFixed(1).replace(/\.0$/, '')
  return `${n}${['KB', 'MB', 'GB'][power - 1]}`
}


export function formatSecondsShort(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms === 0) return '0s'
  if (ms < 1) return formatSecondsShort(ms)
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const total = Math.floor(ms / 60_000) * 60 + Math.round(ms % 60_000 / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts = days ? [`${days}d`, `${hours}h`, `${minutes}m`] : hours ? [`${hours}h`, `${minutes}m`, `${seconds}s`] : [`${minutes}m`, `${seconds}s`]
  if (options?.mostSignificantOnly) return parts[0]!
  if (options?.hideTrailingZeros) while (parts.length > 1 && /^0[smh]$/.test(parts.at(-1)!)) parts.pop()
  return parts.join(' ')
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

export function formatQuietAge(quietMs: number): string {
  const secs = Math.floor(quietMs / 1000)
  if (secs < 60) return `${secs}s`
  const minutes = Math.floor(secs / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`
}

const COMPACT_FIXED = new Intl.NumberFormat('en-US', { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const COMPACT_LOOSE = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function formatNumber(n: number): string {
  return (Math.abs(n) >= 1000 ? COMPACT_FIXED : COMPACT_LOOSE).format(n).toLowerCase()
}

export function formatTokens(n: number): string {
  return formatNumber(n).replace('.0', '')
}

const RELATIVE_UNITS = [
  { unit: 'year', seconds: 31_536_000, narrow: 'y' },
  { unit: 'month', seconds: 2_592_000, narrow: 'mo' },
  { unit: 'week', seconds: 604_800, narrow: 'w' },
  { unit: 'day', seconds: 86_400, narrow: 'd' },
  { unit: 'hour', seconds: 3600, narrow: 'h' },
  { unit: 'minute', seconds: 60, narrow: 'm' },
  { unit: 'second', seconds: 1, narrow: 's' },
] as const

export function formatRelativeTime(
  date: Date,
  options?: {
    style?: 'long' | 'short' | 'narrow'
    numeric?: 'always' | 'auto'
    now?: Date
  },
): string {
  const { style = 'narrow', numeric = 'always', now = new Date() } = options ?? {}
  const diff = Math.trunc((date.getTime() - now.getTime()) / 1000)
  if (diff === 0) return style === 'narrow' ? '0s ago' : getRelativeTimeFormat(style, numeric).format(diff, 'second')
  const unit = RELATIVE_UNITS.find(row => row.seconds <= Math.abs(diff)) ?? RELATIVE_UNITS[6]
  const n = Math.trunc(diff / unit.seconds)
  if (style !== 'narrow') return getRelativeTimeFormat('long', numeric).format(n, unit.unit)
  return n < 0 ? `${-n}${unit.narrow} ago` : `in ${n}${unit.narrow}`
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
  return formatRelativeTime(date, { ...options, now, numeric: date > now ? options?.numeric : 'always' })
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
  const parts = [formatRelativeTimeAgo(log.modified, { style: 'short' })]
  if (log.gitBranch) parts.push(log.gitBranch)
  if (log.fileSize !== undefined) parts.push(formatFileSize(log.fileSize))
  else if (log.messageCount !== undefined) parts.push(`${log.messageCount} messages`)
  if (log.tag) parts.push(`#${log.tag}`)
  if (log.agentSetting) parts.push(`@${log.agentSetting}`)
  if (log.prNumber !== undefined) parts.push(`${log.prRepository ?? ''}#${log.prNumber}`)
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

export function formatResetTime(
  timestampSeconds: number | undefined,
  showTimezone = false,
  showTime = true,
): string | undefined {
  if (!timestampSeconds) return undefined
  const date = new Date(timestampSeconds * 1000)
  const now = new Date()
  const soon = date.getTime() - now.getTime() <= 86_400_000
  const options: Intl.DateTimeFormatOptions = {}
  if (!soon) {
    options.month = 'short'
    options.day = 'numeric'
    if (now.getFullYear() !== date.getFullYear()) options.year = 'numeric'
  }
  if (soon || showTime) {
    options.hour = 'numeric'
    options.hour12 = true
    if (date.getMinutes() !== 0) options.minute = '2-digit'
  }
  const text = new Intl.DateTimeFormat(undefined, options).format(date).replace(/\s*(AM|PM)/, (_, period: string) => period.toLowerCase())
  return showTimezone ? `${text} (${timeZoneAbbreviation(date)})` : text
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
