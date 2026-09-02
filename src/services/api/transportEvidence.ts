
export interface DeepErrorDetail {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
}

export interface TransportFailure extends DeepErrorDetail {
  ts: number
  target?: string
}

const MAX_CAUSE_HOPS = 5
const RING_MAX = 8
const RECENT_WINDOW_MS = 20_000

const ring: TransportFailure[] = []

export function deepestErrorDetail(err: unknown, maxHops = MAX_CAUSE_HOPS): DeepErrorDetail {
  const top = err as { name?: unknown; message?: unknown } | null
  const out: DeepErrorDetail = {
    name: typeof top?.name === 'string' && top.name ? top.name : 'Error',
    message:
      typeof top?.message === 'string' && top.message
        ? top.message
        : String(err ?? 'unknown error'),
  }
  const seen = new Set<unknown>()
  let node: unknown = err
  let hops = 0
  while (node && typeof node === 'object' && hops <= maxHops && !seen.has(node)) {
    seen.add(node)
    const n = node as { code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown }
    if (typeof n.code === 'string' && n.code) out.code = n.code
    if (typeof n.errno === 'number') out.errno = n.errno
    if (typeof n.syscall === 'string' && n.syscall) out.syscall = n.syscall
    node = n.cause
    hops++
  }
  return out
}

const STALE_SOCKET_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
])

export function isStaleSocketCode(code: string | undefined): boolean {
  return code !== undefined && STALE_SOCKET_CODES.has(code)
}

export function recordTransportFailure(err: unknown, url?: string): void {
  try {
    const deep = deepestErrorDetail(err)
    let target: string | undefined
    if (url) {
      try {
        const u = new URL(url)
        target = `${u.host}${u.pathname}`
      } catch {
      }
    }
    ring.push({ ...deep, ts: Date.now(), ...(target ? { target } : {}) })
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  } catch {
  }
}

export function recentTransportFailure(withinMs = RECENT_WINDOW_MS): TransportFailure | undefined {
  const newest = ring[ring.length - 1]
  if (!newest) return undefined
  return Date.now() - newest.ts <= withinMs ? newest : undefined
}

export function _resetTransportEvidenceForTesting(): void {
  ring.length = 0
}
