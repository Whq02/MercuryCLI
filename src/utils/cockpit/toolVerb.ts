
import { pathTailLabel as tail } from '../pathLabel.js'

const MAX_DETAIL = 24

function clip(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

function host(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return clip(url)
  }
}

export function toolVerbFor(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const str = (k: string): string | null =>
    typeof input?.[k] === 'string' && (input[k] as string).length > 0
      ? (input[k] as string)
      : null
  switch (toolName) {
    case 'Bash': {
      const cmd = str('command')
      return cmd ? `Running ${clip(cmd)}` : 'Running a command'
    }
    case 'Read': {
      const p = str('file_path')
      return p ? `Reading ${clip(tail(p))}` : 'Reading'
    }
    case 'Grep': {
      const pat = str('pattern')
      return pat ? `Searching ${clip(pat)}` : 'Searching'
    }
    case 'Glob': {
      const pat = str('pattern')
      return pat ? `Globbing ${clip(pat)}` : 'Globbing'
    }
    case 'Edit': {
      const p = str('file_path')
      return p ? `Editing ${clip(tail(p))}` : 'Editing'
    }
    case 'Write': {
      const p = str('file_path')
      return p ? `Writing ${clip(tail(p))}` : 'Writing'
    }
    case 'NotebookEdit': {
      const p = str('notebook_path')
      return p ? `Editing ${clip(tail(p))}` : 'Editing'
    }
    case 'WebFetch': {
      const u = str('url')
      return u ? `Fetching ${host(u)}` : 'Fetching'
    }
    case 'WebSearch':
    case 'ProviderSearch':
      return 'Searching the web'
    case 'Agent':
      return 'Delegating'
    default:
      return undefined
  }
}

type LooseBlock = { type?: string; id?: string; name?: string; input?: unknown }
type LooseMessage = { type?: string; message?: { content?: unknown } }

export function activeToolVerb(
  messages: readonly unknown[],
  inProgress: ReadonlySet<string>,
  scanLimit = 30,
): string | undefined {
  if (inProgress.size === 0) return undefined
  const from = Math.max(0, messages.length - scanLimit)
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i] as LooseMessage
    if (m?.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b] as LooseBlock
      if (
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        inProgress.has(block.id) &&
        typeof block.name === 'string'
      ) {
        return toolVerbFor(block.name, block.input as Record<string, unknown> | undefined)
      }
    }
  }
  return undefined
}
