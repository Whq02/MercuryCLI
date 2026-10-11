import { dirname } from 'node:path'

import { getFsImplementation } from './fsOperations.js'

export function logForDiagnosticsNoPII(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
): void {
  const logFile = undefined as string | undefined
  if (!logFile) return
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      data: data ?? {},
    }) + '\n'
  const fs = getFsImplementation()
  try {
    fs.appendFileSync(logFile, line)
  } catch {
    try {
      fs.mkdirSync(dirname(logFile))
      fs.appendFileSync(logFile, line)
    } catch {
    }
  }
}

type TimedRun<T> =
  | { outcome: 'completed'; value: T; duration_ms: number }
  | { outcome: 'failed'; error: unknown; duration_ms: number }

async function timed<T>(operation: () => Promise<T>): Promise<TimedRun<T>> {
  const startedAt = Date.now()
  try {
    const value = await operation()
    return { outcome: 'completed', value, duration_ms: Date.now() - startedAt }
  } catch (error) {
    return { outcome: 'failed', error, duration_ms: Date.now() - startedAt }
  }
}

export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  logForDiagnosticsNoPII('info', `${event}_started`)
  const run = await timed(async () => {
    const result = await fn()
    return { result, data: getData?.(result) ?? {} }
  })
  if (run.outcome === 'failed') {
    logForDiagnosticsNoPII('error', `${event}_failed`, { duration_ms: run.duration_ms })
    throw run.error
  }
  logForDiagnosticsNoPII('info', `${event}_completed`, { duration_ms: run.duration_ms, ...run.value.data })
  return run.value.result
}
