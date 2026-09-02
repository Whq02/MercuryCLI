
export const STREAM_IDLE_DEFAULT_MS = 90_000

const STREAM_IDLE_FLOOR_MS = 1_000

export function streamIdleTimeoutMs(): number {
  const raw = process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= STREAM_IDLE_FLOOR_MS ? parsed : STREAM_IDLE_DEFAULT_MS
}

export function compatStreamIdleTimeoutMs(): number {
  return STREAM_IDLE_DEFAULT_MS
}

export function streamIdleWarningMsOf(timeoutMs: number): number {
  return timeoutMs / 2
}

export function streamIdleTimeoutMsForRoute(route: string | null): number {
  return route === null || route === 'anthropic' ? streamIdleTimeoutMs() : compatStreamIdleTimeoutMs()
}
