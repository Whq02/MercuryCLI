// The submission census (MERCURY_SUBMIT_TRACE: a file path) — the live
// instrument for the conditional plain-send double (field
// evidence: one Enter, two identical committed rows, no completion menu).
// Every submission WRITER appends one line at its entry, so a doubled row
// pair in the field names its two entry sites and their spacing without a
// reproduction. Shape-only by law: length + digest prefix, never the text.
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
    // The trace must never break a submission.
  }
}
