
import { getRawUtilization } from '../../services/claudeAiLimits.js'
import type { SnapshotState } from '../../components/mercury-ui/theme.js'

export type QuotaWindow = {
  key: '5h' | '7d'
  usedPct: number | null
  resetsAtMs: number | null
  state: SnapshotState
}

function normalizeWindow(
  key: '5h' | '7d',
  raw: { utilization: number; resets_at: number } | undefined,
): QuotaWindow {
  if (!raw || !Number.isFinite(raw.utilization) || !Number.isFinite(raw.resets_at)) {
    return { key, usedPct: null, resetsAtMs: null, state: 'unavailable' }
  }
  return {
    key,
    usedPct: raw.utilization * 100,
    resetsAtMs: raw.resets_at * 1000,
    state: 'live',
  }
}

export function quotaWindows(): { fiveHour: QuotaWindow; sevenDay: QuotaWindow } {
  const raw = getRawUtilization()
  return {
    fiveHour: normalizeWindow('5h', raw.five_hour),
    sevenDay: normalizeWindow('7d', raw.seven_day),
  }
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay = new Date().toDateString() === d.toDateString()
  if (sameDay) return `${hh}:${mm}`
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return `${wd} ${hh}:${mm}`
}

export function formatCountdown(deltaMs: number): string {
  if (deltaMs <= 0) return 'now'
  if (deltaMs < 60000) return `${Math.max(1, Math.floor(deltaMs / 1000))}s`
  const totalMin = Math.floor(deltaMs / 60000)
  if (totalMin < 60) return `${totalMin}m`
  const totalHr = Math.floor(totalMin / 60)
  if (totalHr < 24) {
    const m = totalMin % 60
    return m > 0 ? `${totalHr}h ${m}m` : `${totalHr}h`
  }
  const d = Math.floor(totalHr / 24)
  const h = totalHr % 24
  return `${d}d ${h}h`
}
