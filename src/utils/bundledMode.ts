
type BunGlobal = {
  embeddedFiles?: unknown
}

export function isRunningWithBun(): boolean {
  return Boolean(process.versions?.bun)
}

export function isInBundledMode(): boolean {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun
  if (!bun) return false
  return Array.isArray(bun.embeddedFiles) && bun.embeddedFiles.length > 0
}
