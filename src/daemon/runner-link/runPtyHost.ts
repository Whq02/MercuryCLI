export type AttachResult =
  | { ok: true; sockPath: string }
  | { ok: false; code: 'ENOTSUP'; error: string }

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
