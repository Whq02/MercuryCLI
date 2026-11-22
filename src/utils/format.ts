import { getRelativeTimeFormat, getTimeZone } from './intl.js'
import { notBuilt } from '../pi/holes.js'

export {
  truncate,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from './truncate.js'


export function formatFileSize(bytes: number): string {
  return notBuilt('src/utils/format.ts:12')
}


export function formatSecondsShort(ms: number): string {
  return notBuilt('src/utils/format.ts:22')
}

export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  return notBuilt('src/utils/format.ts:26')
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
  return notBuilt('src/utils/format.ts:92')
}

export function formatNumber(n: number): string {
  return notBuilt('src/utils/format.ts:113')
}

export function formatTokens(n: number): string {
  return notBuilt('src/utils/format.ts:118')
}

export function formatRelativeTime(
  date: Date,
  options?: {
    style?: 'long' | 'short' | 'narrow'
    numeric?: 'always' | 'auto'
    now?: Date
  },
): string {
  return notBuilt('src/utils/format.ts:137')
}

export function formatRelativeTimeAgo(
  date: Date,
  options?: {
    style?: 'long' | 'short' | 'narrow'
    numeric?: 'always' | 'auto'
    now?: Date
  },
): string {
  return notBuilt('src/utils/format.ts:168')
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
  return notBuilt('src/utils/format.ts:182')
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
  showTimezone?: boolean,
  showTime?: boolean,
): string | undefined {
  return notBuilt('src/utils/format.ts:223')
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
