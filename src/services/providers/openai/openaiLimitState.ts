
export type OpenaiLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

export type OpenaiLimitSource = 'chatgpt-subscription' | 'api-key'

const observedBySource: Record<OpenaiLimitSource, { resetsAtMs: number; observedAtMs: number } | null> = {
  'chatgpt-subscription': null,
  'api-key': null,
}

export function recordOpenaiUsageLimit(
  resetsAtMs: number | undefined,
  source: OpenaiLimitSource,
  now: () => number = Date.now,
): void {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return
  observedBySource[source] = { resetsAtMs, observedAtMs: now() }
}

export function openaiLimitWindow(source: OpenaiLimitSource, now: () => number = Date.now): OpenaiLimitWindow {
  const observed = observedBySource[source]
  if (observed === null || observed.resetsAtMs <= now()) return { state: 'clear' }
  return { state: 'limited', resetsAtMs: observed.resetsAtMs, observedAtMs: observed.observedAtMs }
}

export function openaiObservedWall(source: OpenaiLimitSource): { resetsAtMs: number; observedAtMs: number } | null {
  return observedBySource[source]
}

export function forgetOpenaiLimitSource(source: OpenaiLimitSource): void {
  observedBySource[source] = null
  if (source === 'chatgpt-subscription') observedUsage = {}
}


export interface OpenaiObservedWindow {
  usedPct?: number
  windowMinutes?: number
  resetsAtMs?: number
  observedAtMs: number
}

export interface OpenaiObservedUsage {
  primary?: OpenaiObservedWindow
  secondary?: OpenaiObservedWindow
}

let observedUsage: OpenaiObservedUsage = {}

function finiteOrUndefined(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function recordOpenaiRateHeaders(
  headers: Headers | undefined,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const next: OpenaiObservedUsage = { ...observedUsage }
    for (const band of ['primary', 'secondary'] as const) {
      const usedPct = finiteOrUndefined(headers.get(`x-codex-${band}-used-percent`))
      if (usedPct === undefined || usedPct < 0 || usedPct > 100) continue
      const windowMinutes = finiteOrUndefined(headers.get(`x-codex-${band}-window-minutes`))
      const resetAfterSeconds = finiteOrUndefined(
        headers.get(`x-codex-${band}-reset-after-seconds`),
      )
      next[band] = {
        usedPct,
        ...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes } : {}),
        ...(resetAfterSeconds !== undefined && resetAfterSeconds >= 0
          ? { resetsAtMs: now() + resetAfterSeconds * 1000 }
          : {}),
        observedAtMs: now(),
      }
    }
    observedUsage = next
  } catch {
  }
}

export function openaiObservedUsage(): OpenaiObservedUsage {
  return observedUsage
}

export function adoptOpenaiObservedUsage(
  record: { primary?: OpenaiObservedWindow; secondary?: OpenaiObservedWindow } | undefined,
): void {
  if (!record || typeof record !== 'object') return
  try {
    const next: OpenaiObservedUsage = { ...observedUsage }
    let moved = false
    for (const band of ['primary', 'secondary'] as const) {
      const incoming = record[band]
      if (!incoming || typeof incoming !== 'object') continue
      const at = incoming.observedAtMs
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      const usedPct = incoming.usedPct
      if (typeof usedPct !== 'number' || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) continue
      const held = next[band]
      if (held !== undefined && held.observedAtMs >= at) continue
      next[band] = {
        usedPct,
        ...(typeof incoming.windowMinutes === 'number' && incoming.windowMinutes > 0
          ? { windowMinutes: incoming.windowMinutes }
          : {}),
        ...(typeof incoming.resetsAtMs === 'number' && Number.isFinite(incoming.resetsAtMs)
          ? { resetsAtMs: incoming.resetsAtMs }
          : {}),
        observedAtMs: at,
      }
      moved = true
    }
    if (moved) observedUsage = next
  } catch {
  }
}

export function __resetOpenaiLimitStateForTest(): void {
  observedBySource['chatgpt-subscription'] = null
  observedBySource['api-key'] = null
  observedUsage = {}
}
