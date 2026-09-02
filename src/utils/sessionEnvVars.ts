
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
