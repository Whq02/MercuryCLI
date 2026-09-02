import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { flagEnv } from '../substrate/flagRegistry.js'

export function submitTrace(
  site: string,
  text: string,
  detail?: Record<string, string | number | boolean>,
): void {
  const path = flagEnv('MERCURY_SUBMIT_TRACE')
  if (!path) return
  try {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
    appendFileSync(
      path,
      `${JSON.stringify({ at: Date.now(), site, len: text.length, digest, ...detail })}\n`,
    )
  } catch {
  }
}
