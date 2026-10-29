type SemverLib = {
  gt: (a: string, b: string, loose?: boolean) => boolean
  gte: (a: string, b: string, loose?: boolean) => boolean
}

let lib: SemverLib | null = null

function loadLib(): SemverLib {
  if (!lib) lib = require('semver') as SemverLib
  return lib
}

type BunSemver = { order: (a: string, b: string) => -1 | 0 | 1 }

function bunSemver(): BunSemver | null {
  const bun = (globalThis as { Bun?: { semver?: BunSemver } }).Bun
  return bun?.semver && typeof bun.semver.order === 'function' ? bun.semver : null
}

export function gt(a: string, b: string): boolean {
  const native = bunSemver()
  if (native) return native.order(a, b) > 0
  return loadLib().gt(a, b, true)
}

export function gte(a: string, b: string): boolean {
  const native = bunSemver()
  if (native) return native.order(a, b) >= 0
  return loadLib().gte(a, b, true)
}
