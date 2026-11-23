import uniq from 'lodash-es/uniq.js'

export function extractAtMentionedFiles(content: string): string[] {
  return [...parseMentions(content).files]
}

export function extractMcpResourceMentions(content: string): string[] {
  return [...parseMentions(content).resources]
}

export function extractAgentMentions(content: string): string[] {
  return [...parseMentions(content).agents]
}

type AtMentionedFileLines = { filename: string; lineStart?: number; lineEnd?: number }

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  const match = /^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/.exec(mention)
  if (!match) return { filename: mention }
  const lineStart = match[2] === undefined ? undefined : Number(match[2])
  const lineEnd = match[3] === undefined ? lineStart : Math.max(lineStart!, Number(match[3]))
  return { filename: match[1]!, lineStart, lineEnd }
}

interface ParsedMentions {
  readonly files: readonly string[]
  readonly agents: readonly string[]
  readonly resources: readonly string[]
}

let lastInput: string | undefined
let lastParsed: ParsedMentions | undefined

export function parseMentions(content: string): ParsedMentions {
  if (lastParsed && content === lastInput) return lastParsed
  const matches = (rule: RegExp) => Array.from(content.matchAll(rule), match => match[1]!)
  const quotedFiles = matches(/(?:^|\s)@"([^"]+)"/g).filter(value => !value.endsWith(' (agent)'))
  const words = matches(/(?:^|\s)@(\S+)/g).map(value => value.replace(/\W+$/, '')).filter(Boolean)
  const plainFiles = words.filter(value => !value.startsWith('"'))
  const quotedAgents = matches(/(?:^|\s)@"([\w:.@-]+) \(agent\)"/g)
  const plainAgents = matches(/(?:^|\s)@(agent-[\w:.@-]+)/g)
  const resources = words.filter(value => /^.+:.+$/s.test(value))
  lastInput = content
  lastParsed = Object.freeze({
    files: Object.freeze(uniq([...quotedFiles, ...plainFiles])),
    agents: Object.freeze(uniq([...quotedAgents, ...plainAgents])),
    resources: Object.freeze(uniq(resources)),
  })
  return lastParsed
}
