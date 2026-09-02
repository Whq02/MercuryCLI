/**
 * Runtime-mode probes: whether we are executing under Bun at all, and whether
 * we are a Bun-compiled standalone binary (embedded files present).
 */

type BunGlobal = {
  embeddedFiles?: unknown
}

/** True when the runtime reports a Bun version. */
export function isRunningWithBun(): boolean {
  return Boolean(process.versions?.bun)
}

/**
 * True when the Bun global exists and exposes a non-empty array of embedded
 * files — the signature of a compiled standalone binary as opposed to
 * `bun run` over sources.
 */
export function isInBundledMode(): boolean {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun
  if (!bun) return false
  return Array.isArray(bun.embeddedFiles) && bun.embeddedFiles.length > 0
}
