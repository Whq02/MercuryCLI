import { existsSync, rmSync } from 'node:fs'

export const REMOVE_RETRY_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

export type RemoveScratchOptions = {
  maxRetries?: number
  retryDelayMs?: number
  remove?: (target: string) => void
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function removeScratch(target: string, options: RemoveScratchOptions = {}): void {
  const maxRetries = options.maxRetries ?? 10
  const retryDelayMs = options.retryDelayMs ?? 100
  const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  for (let attempt = 0; ; attempt++) {
    try {
      remove(target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT' && !existsSync(target)) return
      if (attempt >= maxRetries || (code !== 'ENOENT' && !REMOVE_RETRY_CODES.has(code))) throw error
      pause(retryDelayMs * (attempt + 1))
    }
  }
}
