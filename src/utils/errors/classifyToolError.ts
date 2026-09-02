// ============================================================================
//  classifyToolError — pure classifier behind Mercury's fallback tool-error card.
//
//  Splits a raw tool-error blob into the pieces the card renders: the headline
//  (first meaningful line, painted CRIMSON), a capped FAINT body, a stack-frame
//  count (frames are FOLDED into a `└ +N stack frames` row, never painted raw),
//  and a one-line fix hint for the known errno classes. Pure string work — no
//  react, no fs — so it stays bun-loadable for the table proof
//  (scripts/ui/prove-classify-tool-error.ts).
// ============================================================================

export type ClassifiedToolError = {
  /** The headline: first non-blank, non-stack-frame line (trimmed). '' when none. */
  firstLine: string
  /** Non-frame lines after the headline (leading/trailing blanks dropped), capped. */
  bodyLines: string[]
  /** Count of ` at …` stack-frame lines in the WHOLE text. */
  stackFrameCount: number
  /** One-line operator fix when the text matches a known error class. */
  hint?: string
}

/** A V8/Node stack-frame line (` at fn (file.ts:1:2)`). */
const STACK_FRAME_RE = /^\s+at /

/** Known error classes → a one-line fix. First match (in this order) wins.
 *  PLATFORM-HONEST: on Windows, EPERM/EACCES/EBUSY on a
 *  file operation is almost never a Unix modes/ownership problem — it is the
 *  transient file-use conflict class (antivirus, the search indexer, another
 *  program's open handle) that Mercury's durable publisher already retried
 *  with the bounded 50/100/200ms backoff. Sending a Windows operator to
 *  chmod was inaccurate guidance; name the real actors instead. */
function hintsFor(platform: NodeJS.Platform): ReadonlyArray<readonly [RegExp, string]> {
  return [
    [/\bENOENT\b/, 'path does not exist — check the cwd/spelling'],
    platform === 'win32'
      ? [
          /\bEACCES\b|\bEPERM\b|\bEBUSY\b/,
          'file in use — on Windows this is usually a short-lived lock by another program (antivirus, search indexer, an open editor/terminal handle); Mercury retried briefly — if it persists, close whatever holds the file or exclude the folder from real-time scanning',
        ]
      : [/\bEACCES\b|\bEPERM\b/, 'permission denied — check file modes/ownership'],
    [/\bETIMEDOUT\b|timed out/i, 'timed out — retry or raise the timeout'],
    [/\bENOSPC\b/, 'disk full'],
  ]
}

// The card shows the headline on its own row, so 1 + 9 body lines matches the
// legacy card's 10-raw-line ceiling.
const DEFAULT_BODY_CAP = 9

export function classifyToolError(
  text: string,
  cap: number = DEFAULT_BODY_CAP,
  /** Pinnable for the table proof; production callers take the live OS. */
  platform: NodeJS.Platform = process.platform,
): ClassifiedToolError {
  let stackFrameCount = 0
  const nonFrame: string[] = []
  for (const line of text.split('\n')) {
    if (STACK_FRAME_RE.test(line)) stackFrameCount++
    else nonFrame.push(line.trimEnd())
  }
  const headIdx = nonFrame.findIndex(l => l.trim() !== '')
  const firstLine = headIdx >= 0 ? (nonFrame[headIdx] as string).trim() : ''
  const body = headIdx >= 0 ? nonFrame.slice(headIdx + 1) : []
  while (body.length > 0 && (body[0] as string).trim() === '') body.shift()
  while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop()
  const bodyLines = body.slice(0, Math.max(0, cap))
  const hint = hintsFor(platform).find(([re]) => re.test(text))?.[1]
  return { firstLine, bodyLines, stackFrameCount, hint }
}
