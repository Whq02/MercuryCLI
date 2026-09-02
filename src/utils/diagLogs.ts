import { dirname } from 'node:path'

import { getFsImplementation } from './fsOperations.js'

/**
 * PII-free structured diagnostics log. Enabled only when the dedicated env
 * var names a log file; otherwise every call is a no-op.
 *
 * CONTRACT: callers must never pass personally-identifying data — no file
 * paths, no project or repository names, no prompts. The file is read by an
 * external ingestion path, so the record key spellings are contract data.
 */
export function logForDiagnosticsNoPII(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
): void {
  // Always a no-op: no diagnostics-file sink exists; the call sites stay
  // as the diagnostics seam.
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
      // Create the parent chain and retry once; a second failure is silent.
      fs.mkdirSync(dirname(logFile))
      fs.appendFileSync(logFile, line)
    } catch {
      // Diagnostics must never break the product.
    }
  }
}

/**
 * Run an async function bracketed by `<event>_started` / `<event>_completed`
 * entries (the completion carrying a duration and any caller-derived data),
 * or `<event>_failed` with only the duration when it throws — re-throwing.
 */
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
