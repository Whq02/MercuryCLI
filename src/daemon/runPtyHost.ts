// Mercury daemon — the (dormant) PTY-attach tier.
//
// Mercury's runtime is node, and node here has no pseudo-terminal primitive
// to offer: `Bun.Terminal` exists only under Bun, and node-pty is kept out of
// the dependency tree on purpose. The daemon therefore hosts no live
// terminals — rostered jobs run as isolated headless children whose final
// output is captured in memory, and their state is queried through the
// daemon's `list`/`status` ops rather than by attaching.
//
// The tier still exists as an honest capability seam: {@link isPtyHostAvailable}
// probes for a terminal primitive without importing or spawning anything, and
// {@link attachToJobPty} answers ENOTSUP with an actionable message the control
// server relays verbatim. A future runtime that does carry a PTY primitive
// (Bun, or a build that adds node-pty) can layer the real attach tier behind
// this same probe without touching the control protocol.

/**
 * Does this runtime have a usable PTY primitive? Pure capability probe — no
 * spawn, no dynamic import, never throws. True only when `Bun.Terminal`
 * exists on the global; the node product answers false. (A node-pty probe
 * would slot in beside it, but the package is intentionally absent, so its
 * absence is simply "not available" — never an error.)
 */
export function isPtyHostAvailable(): boolean {
  const maybeBun = (globalThis as { Bun?: { Terminal?: unknown } }).Bun
  if (maybeBun && typeof maybeBun.Terminal !== 'undefined') return true
  return false
}

/** Result of an attach attempt. */
export type AttachResult =
  | { ok: true; sockPath: string }
  | { ok: false; code: 'ENOTSUP'; error: string }

/**
 * Attach to a job's terminal. Degraded in this runtime: always returns an
 * ENOTSUP-shaped refusal (never throws, never blocks) with a message that
 * points the caller at the ops that DO answer — `list`/`status`.
 */
export function attachToJobPty(short: string): AttachResult {
  return {
    ok: false,
    code: 'ENOTSUP',
    error:
      `attach requires a PTY host (Bun.Terminal) — unavailable in the Mercury ` +
      `node runtime; job ${short} runs headless with no live terminal. Use the ` +
      `daemon's 'list'/'status' to see its state (final output is captured, not streamed).`,
  }
}
