/**
 * In-memory session-scoped environment overrides, applied ONLY to spawned
 * children through the shell providers' environment overrides — never to the
 * running process. (The environment command that would populate the map is a
 * disabled stub in this tree, so the setters are not built; the readers and
 * the clear stay for their live importers.)
 */

const sessionEnvVars = new Map<string, string>()

/** The live map, exposed read-only — not a defensive copy; holders see later mutations. */
export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
