
type BunGlobal = {
  embeddedFiles?: unknown
}

export function isInBundledMode(): boolean {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun
  if (!bun) return false
  return Array.isArray(bun.embeddedFiles) && bun.embeddedFiles.length > 0
}
