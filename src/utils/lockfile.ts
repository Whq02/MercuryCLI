import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'
import { notBuilt } from '../pi/holes.js'

export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  return notBuilt('src/utils/lockfile.ts:14')
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return notBuilt('src/utils/lockfile.ts:18')
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return notBuilt('src/utils/lockfile.ts:22')
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return notBuilt('src/utils/lockfile.ts:26')
}
