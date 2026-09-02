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

export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now()
  logForDiagnosticsNoPII('info', `${event}_started`)
  try {
    const result = await fn()
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - start,
      ...(getData ? getData(result) : {}),
    })
    return result
  } catch (err) {
    logForDiagnosticsNoPII('error', `${event}_failed`, { duration_ms: Date.now() - start })
    throw err
  }
}
