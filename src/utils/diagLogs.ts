import { dirname } from 'node:path'

import { getFsImplementation } from './fsOperations.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

export function logForDiagnosticsNoPII(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
): void {
  return notBuilt('src/utils/diagLogs.ts:6')
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
  return notBuilt('src/utils/diagLogs.ts:47')
}
