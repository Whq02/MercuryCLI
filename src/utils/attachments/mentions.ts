
import uniq from 'lodash-es/uniq.js'

export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  let match
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2])
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || []
  regularMatchArray.forEach(m => {
    const filename = m.slice(m.indexOf('@') + 1)
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  return uniq([...quotedMatches, ...regularMatches])
}

export function extractMcpResourceMentions(content: string): string[] {
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g
  const matches = content.match(atMentionRegex) || []
  return uniq(matches.map(m => m.slice(m.indexOf('@') + 1)))
}

export function extractAgentMentions(content: string): string[] {
  const results: string[] = []

  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
  let match
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g
  const unquotedMatches = content.match(unquotedAgentRegex) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }

  return uniq(results)
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)
  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  let lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    lineEnd = lineStart
  }

  return { filename: filename ?? mention, lineStart, lineEnd }
}
