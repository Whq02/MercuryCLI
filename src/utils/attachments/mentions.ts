import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function extractAtMentionedFiles(content: string): string[] {
  return notBuilt('src/utils/attachments/mentions.ts:1')
}

export function extractMcpResourceMentions(content: string): string[] {
  return notBuilt('src/utils/attachments/mentions.ts:5')
}

export function extractAgentMentions(content: string): string[] {
  return notBuilt('src/utils/attachments/mentions.ts:9')
}

type AtMentionedFileLines = Unbuilt

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  return notBuilt('src/utils/attachments/mentions.ts:19')
}

interface ParsedMentions {
  readonly files: readonly string[]
  readonly agents: readonly string[]
  readonly resources: readonly string[]
}

let lastInput: string | undefined
let lastParsed: ParsedMentions | undefined

export function parseMentions(content: string): ParsedMentions {
  return notBuilt('src/utils/attachments/mentions.ts:42')
}
