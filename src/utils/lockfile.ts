import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

/**
 * A lazy facade over the file-locking package. Its transitive dependency
 * replaces every filesystem method at initialisation (~8 ms), so importing it
 * statically would tax every launch — including `--help` and `--version`.
 * The package is required on the first call and kept; the require is
 * synchronous so the sync entry point stays synchronous.
 */
type LockfileModule = typeof import('proper-lockfile')

let cached: LockfileModule | null = null

function load(): LockfileModule {
  if (!cached) {
    // The module-scope `require` the bundler can see: the package is inlined
    // and still evaluated on first call. A handle built from import.meta.url
    // would survive bundling as a runtime lookup beside the artifact, where
    // no node_modules exists (BUILD-NOTES.md §undici).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('proper-lockfile') as LockfileModule
  }
  return cached
}

export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  return load().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return load().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return load().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return load().check(file, options)
}
