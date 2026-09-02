/**
 * Version comparison with a fast runtime-native path (roughly twenty times
 * faster) and a lazily-required library fallback using loose parsing. The
 * runtime test runs per call — no memoised branch — and the comparison
 * operators are expressed in terms of the native ORDERING result.
 */

type SemverLib = {
  gt: (a: string, b: string, loose?: boolean) => boolean
  gte: (a: string, b: string, loose?: boolean) => boolean
  lt: (a: string, b: string, loose?: boolean) => boolean
  satisfies: (version: string, range: string, loose?: boolean) => boolean
  compare: (a: string, b: string, loose?: boolean) => -1 | 0 | 1
}

let lib: SemverLib | null = null

function loadLib(): SemverLib {
  if (!lib) lib = require('semver') as SemverLib
  return lib
}

type BunSemver = { order: (a: string, b: string) => -1 | 0 | 1; satisfies: (version: string, range: string) => boolean }

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

export function lt(a: string, b: string): boolean {
  const native = bunSemver()
  if (native) return native.order(a, b) < 0
  return loadLib().lt(a, b, true)
}

export function satisfies(version: string, range: string): boolean {
  const native = bunSemver()
  if (native) return native.satisfies(version, range)
  return loadLib().satisfies(version, range, true)
}
