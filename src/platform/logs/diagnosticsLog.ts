export function logForDiagnosticsNoPII(
  _level: 'debug' | 'info' | 'warn' | 'error',
  _event: string,
  _data?: Record<string, unknown>,
): void {}

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
