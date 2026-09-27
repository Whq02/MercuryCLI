import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export function captureExitDetail(result: Pick<SpawnSyncReturns<string | Buffer>, 'status' | 'signal' | 'error' | 'stderr'>, ceilingMs?: number): string {
  const words = result.stderr?.toString().trim() ?? ''
  const error = result.error ? `${(result.error as NodeJS.ErrnoException).code ?? result.error.name}: ${result.error.message}` : ''
  return [`capture exit=${result.status ?? 'null'}`, result.signal ? `signal=${result.signal}` : '', ceilingMs === undefined ? '' : `ceiling=${ceilingMs}ms`, error, words].filter(Boolean).join(' · ')
}

export const spawnCaptureSync: typeof spawnSync = ((...args: Parameters<typeof spawnSync>) => {
  const result = spawnSync(...args)
  if (result.status !== 0 || result.error) {
    const options = args[2] ?? (Array.isArray(args[1]) ? undefined : args[1])
    console.error(captureExitDetail(result, options?.timeout))
  }
  return result
}) as typeof spawnSync
