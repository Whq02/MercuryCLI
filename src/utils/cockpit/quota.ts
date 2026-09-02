// ============================================================================
//  utils/cockpit/quota — the normalized Max-subscription usage model.
//
//  ONE definition of the 5h / 7d rolling-window quota, read from the live
//  getRawUtilization() singleton (populated on every main API response from the
//  anthropic-ratelimit-unified-{5h,7d}-{utilization,reset} headers — no extra
//  API call). Both the MercuryFrame chips and the /deck gauges normalize through
//  here so the honest-empty rule is single-source:
//    - a window key present  ⇒ live (usedPct + resetsAtMs)
//    - a window key absent   ⇒ unavailable (NOT 0% — the hard do-not-fake rule)
//  resets_at is unix epoch SECONDS (claudeAiLimits.ts:152); we carry it as ms.
//
//  No per-second timer: callers recompute the countdown on the same render poll
//  as cost/context. formatClock / formatCountdown are pure.
// ============================================================================

import { getRawUtilization } from '../../services/claudeAiLimits.js'
import type { SnapshotState } from '../../components/mercury-ui/theme.js'

export type QuotaWindow = {
  key: '5h' | '7d'
  // null ⇒ unknown. We never coerce unknown to 0 (that would read as "calm").
  usedPct: number | null
  resetsAtMs: number | null
  state: SnapshotState // 'live' when the window key exists, else 'unavailable'
}

// Map one raw window (or undefined) to the normalized model. Undefined / missing
// ⇒ unavailable, never 0%. utilization is a 0-1 fraction → percent.
function normalizeWindow(
  key: '5h' | '7d',
  raw: { utilization: number; resets_at: number } | undefined,
): QuotaWindow {
  // Belt-and-suspenders: a present-but-non-finite window (NaN/Infinity from a
  // garbage header) is treated as ABSENT, never published as live 0%/NaN%.
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

// The two canonical windows, read live. Empty {} (non-subscriber /
// pre-first-response) → both unavailable.
export function quotaWindows(): { fiveHour: QuotaWindow; sevenDay: QuotaWindow } {
  const raw = getRawUtilization()
  return {
    fiveHour: normalizeWindow('5h', raw.five_hour),
    sevenDay: normalizeWindow('7d', raw.seven_day),
  }
}

// Exact local reset clock, e.g. "14:32" (same day) or "Mon 09:00" (other day).
export function formatClock(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay = new Date().toDateString() === d.toDateString()
  if (sameDay) return `${hh}:${mm}`
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return `${wd} ${hh}:${mm}`
}

// Countdown to a reset: ≤0 ⇒ "now" (the window has reset / is due) · <60s ⇒
// "Ns" · <60m ⇒ "Xm" · <24h ⇒ "Yh" / "Yh Xm" · ≥24h ⇒ "Nd Yh". Sub-minute and
// elapsed deltas are NOT clamped to a misleading "0m" (≈now) —.
// Recomputed on the render poll — no per-second timer.
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
