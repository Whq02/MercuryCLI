
export type ClassifiedToolError = {
  firstLine: string
  bodyLines: string[]
  stackFrameCount: number
  hint?: string
}

const STACK_FRAME_RE = /^\s+at /

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

const DEFAULT_BODY_CAP = 9

export function classifyToolError(
  text: string,
  cap: number = DEFAULT_BODY_CAP,
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
