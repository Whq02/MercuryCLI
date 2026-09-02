/**
 * transportEvidence —/N-02: keep the transport-failure evidence the SDK
 * throws away.
 *
 * Two independent losses put "Request timed out." in 20/27 field api_error
 * rows with no code attached:
 *   1. the SDK's timeout class (`APIConnectionTimeoutError`) is constructed
 *      WITHOUT the caught cause — the `UND_ERR_CONNECT_TIMEOUT` chain is
 *      destroyed at the throw site (verified in @anthropic-ai/sdk 0.104.1 and
 *      again at 0.122.0 — client.mjs throws `new APIConnectionTimeoutError()`
 *      bare, and the class takes only a message);
 *   2. the errorDetail fold walked ONE cause level while undici codes sit two
 *      deep (`APIConnectionError → TypeError('fetch failed') → UndiciError`).
 *
 * This module owns both repairs:
 *   - {@link deepestErrorDetail}: a bounded cause-chain walk (≤5 hops,
 *     cycle-safe) returning the DEEPEST code/errno/syscall;
 *   - a small process-recent failure ring fed by our own fetch wrapper
 *     (client.ts buildFetch) BEFORE the SDK classifies-and-drops. When a
 *     cause-less SDK timeout is folded, the ring supplies the likely class,
 *     labeled honestly as 'recent-failure' with its age — never presented as
 *     request-bound truth.
 */

export interface DeepErrorDetail {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
}

export interface TransportFailure extends DeepErrorDetail {
  ts: number
  /** host+pathname only — never query strings or bodies. */
  target?: string
}

const MAX_CAUSE_HOPS = 5
const RING_MAX = 8
/** A ring entry older than this is stale context, not evidence. */
const RECENT_WINDOW_MS = 20_000

const ring: TransportFailure[] = []

/** Walk the cause chain (bounded, cycle-safe) and return the DEEPEST node's
 *  code/errno/syscall with the outermost name/message as identity. */
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

/**
 * The stale-socket signature (headless-deadline lane, B3.5): a request that
 * died because it rode a connection the server had already closed — the
 * kernel-visible resets plus undici's own vocabulary for the same event
 * (`SocketError: other side closed` carries UND_ERR_SOCKET; a request handed
 * to an agent retired by the stale-pool reset carries UND_ERR_CLOSED /
 * UND_ERR_DESTROYED). One predicate for both the API retry loop and the MCP
 * client, so the two seams recognise the same wire event.
 */
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

/** Record one transport-level fetch failure (called by the API fetch wrapper
 *  before the SDK sees — and may discard — the error). Never throws. */
export function recordTransportFailure(err: unknown, url?: string): void {
  try {
    const deep = deepestErrorDetail(err)
    let target: string | undefined
    if (url) {
      try {
        const u = new URL(url)
        target = `${u.host}${u.pathname}`
      } catch {
        /* keep evidence even for unparseable urls — just without a target */
      }
    }
    ring.push({ ...deep, ts: Date.now(), ...(target ? { target } : {}) })
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  } catch {
    /* evidence collection must never break a request */
  }
}

/** The newest recorded failure within the recency window, or undefined. */
export function recentTransportFailure(withinMs = RECENT_WINDOW_MS): TransportFailure | undefined {
  const newest = ring[ring.length - 1]
  if (!newest) return undefined
  return Date.now() - newest.ts <= withinMs ? newest : undefined
}

/** TEST-ONLY: clear the ring so proofs can assert the no-evidence path. */
export function _resetTransportEvidenceForTesting(): void {
  ring.length = 0
}
