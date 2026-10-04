export function extractAtMentionedFiles(content: string): string[] {
  return [...parseMentions(content).files]
}

export function extractMcpResourceMentions(content: string): string[] {
  return [...parseMentions(content).resources]
}

export function extractAgentMentions(content: string): string[] {
  return [...parseMentions(content).agents]
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  const parts = /^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/.exec(mention)
  if (!parts) return { filename: mention }
  const lineStart = parts[2] ? Number.parseInt(parts[2], 10) : undefined
  const end = parts[3] ? Number.parseInt(parts[3], 10) : lineStart
  return {
    filename: parts[1] ?? mention,
    lineStart,
    lineEnd: lineStart !== undefined && end !== undefined ? Math.max(lineStart, end) : end,
  }
}

export interface ParsedMentions {
  readonly files: readonly string[]
  readonly agents: readonly string[]
  readonly resources: readonly string[]
}

let lastInput: string | undefined
let lastParsed: ParsedMentions | undefined

export function parseMentions(content: string): ParsedMentions {
  if (content === lastInput && lastParsed) return lastParsed
  const quotedFiles: string[] = []
  const plainFiles: string[] = []
  const quotedAgents: string[] = []
  const plainAgents: string[] = []
  const resources: string[] = []
  const rules = [
    { pattern: /(^|\s)@"([^"]+)"/g, accept: (value: string) => {
      if (!value.endsWith(' (agent)')) quotedFiles.push(value)
    } },
    { pattern: /(^|\s)@([^\s]+)\b/g, accept: (value: string) => {
      if (!value.startsWith('"')) plainFiles.push(value)
    } },
    { pattern: /(^|\s)@"([\w:.@-]+) \(agent\)"/g, accept: (value: string) => quotedAgents.push(value) },
    { pattern: /(^|\s)@(agent-[\w:.@-]+)/g, accept: (value: string) => plainAgents.push(value) },
    { pattern: /(^|\s)@([^\s]+:[^\s]+)\b/g, accept: (value: string) => resources.push(value) },
  ]
  for (const { pattern, accept } of rules) {
    for (const match of content.matchAll(pattern)) {
      if (match[2]) accept(match[2])
    }
  }
  lastInput = content
  lastParsed = Object.freeze({
    files: Object.freeze([...new Set([...quotedFiles, ...plainFiles])]),
    agents: Object.freeze([...new Set([...quotedAgents, ...plainAgents])]),
    resources: Object.freeze([...new Set(resources)]),
  })
  return lastParsed
}
