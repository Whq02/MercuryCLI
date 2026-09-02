import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type LockfileModule = typeof import('proper-lockfile')

let cached: LockfileModule | null = null

function load(): LockfileModule {
  if (!cached) {
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
