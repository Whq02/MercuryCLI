import { extractOutputRedirections, splitCommandWithOperators } from './commands.js'
import type { Node } from './parser.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'

export type OutputRedirection = {
  target: string
  operator: '>' | '>>'
}

export interface IParsedCommand {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
  getTreeSitterAnalysis(): TreeSitterAnalysis | null
}

type RedirectionRecord = {
  target: string
  operator: '>' | '>>'
  startIndex: number
  endIndex: number
}

class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  private readonly commandBytes: Buffer
  private readonly pipePositions: number[]
  private readonly redirections: RedirectionRecord[]
  private readonly analysis: TreeSitterAnalysis

  constructor(command: string, rootNode: Node) {
    this.originalCommand = command
    this.commandBytes = Buffer.from(command, 'utf8')
    this.pipePositions = collectPipePositions(rootNode)
    this.redirections = collectOutputRedirections(rootNode)
    this.analysis = analyzeCommand(rootNode, command)
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    if (this.pipePositions.length === 0) {
      return [this.originalCommand]
    }
    const segments: string[] = []
    let start = 0
    for (const position of this.pipePositions) {
      segments.push(this.commandBytes.subarray(start, position).toString('utf8'))
      start = position + 1
    }
    segments.push(this.commandBytes.subarray(start).toString('utf8'))
    return segments.map(segment => segment.trim()).filter(segment => segment.length > 0)
  }

  withoutOutputRedirections(): string {
    if (this.redirections.length === 0) {
      return this.originalCommand
    }
    const ordered = [...this.redirections].sort((a, b) => b.startIndex - a.startIndex)
    let bytes = this.commandBytes
    for (const record of ordered) {
      bytes = Buffer.concat([bytes.subarray(0, record.startIndex), bytes.subarray(record.endIndex)])
    }
    return bytes.toString('utf8').trim().replace(/\s+/g, ' ')
  }

  getOutputRedirections(): OutputRedirection[] {
    return this.redirections.map(({ target, operator }) => ({ target, operator }))
  }

  getTreeSitterAnalysis(): TreeSitterAnalysis {
    return this.analysis
  }
}

function collectPipePositions(rootNode: Node): number[] {
  const positions: number[] = []
  const visit = (node: Node): void => {
    if (node.type === 'pipeline') {
      for (const child of node.children) {
        if (child.type === '|') positions.push(child.startIndex)
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(rootNode)
  positions.sort((a, b) => a - b)
  return positions
}

function collectOutputRedirections(rootNode: Node): RedirectionRecord[] {
  const records: RedirectionRecord[] = []
  const visit = (node: Node): void => {
    if (node.type === 'file_redirect') {
      const operatorChild = node.children.find(
        child => child.type === '>' || child.type === '>>',
      )
      const targetChild = node.children.find(child => child.type === 'word')
      if (operatorChild && targetChild) {
        records.push({
          target: targetChild.text,
          operator: operatorChild.type as '>' | '>>',
          startIndex: node.startIndex,
          endIndex: node.endIndex,
        })
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(rootNode)
  return records
}

export class RegexParsedCommand_DEPRECATED implements IParsedCommand {
  readonly originalCommand: string

  constructor(command: string) {
    this.originalCommand = command
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    try {
      const tokens = splitCommandWithOperators(this.originalCommand)
      const segments: string[] = []
      let group: string[] = []
      for (const token of tokens) {
        if (token === '|') {
          if (group.length > 0) segments.push(group.join(' '))
          group = []
        } else {
          group.push(token)
        }
      }
      if (group.length > 0) segments.push(group.join(' '))
      const nonEmpty = segments.filter(segment => segment.length > 0)
      if (nonEmpty.length === 0) {
        return [this.originalCommand]
      }
      return nonEmpty
    } catch {
      return [this.originalCommand]
    }
  }

  withoutOutputRedirections(): string {
    if (!this.originalCommand.includes('>')) {
      return this.originalCommand
    }
    const extraction = extractOutputRedirections(this.originalCommand)
    if (extraction.redirections.length > 0) {
      return extraction.commandWithoutRedirections
    }
    return this.originalCommand
  }

  getOutputRedirections(): OutputRedirection[] {
    return extractOutputRedirections(this.originalCommand).redirections
  }

  getTreeSitterAnalysis(): null {
    return null
  }
}

let astAvailabilityPromise: Promise<boolean> | null = null
function isAstLaneAvailable(): Promise<boolean> {
  astAvailabilityPromise ??= (async () => {
    try {
      const parserModule = await import('./parser.js')
      const parsed = await parserModule.parseCommand('echo hello')
      return parsed !== null
    } catch {
      return false
    }
  })()
  return astAvailabilityPromise
}

export function buildParsedCommandFromRoot(command: string, rootNode: Node): IParsedCommand {
  return new TreeSitterParsedCommand(command, rootNode)
}

async function parseUncached(command: string): Promise<IParsedCommand> {
  if (await isAstLaneAvailable()) {
    try {
      const parserModule = await import('./parser.js')
      const parsed = await parserModule.parseCommand(command)
      if (parsed) {
        return new TreeSitterParsedCommand(command, parsed.rootNode)
      }
    } catch {
    }
  }
  return new RegexParsedCommand_DEPRECATED(command)
}

let lastParseKey: string | null = null
let lastParsePromise: Promise<IParsedCommand | null> | null = null

export const ParsedCommand = {
  parse(command: string): Promise<IParsedCommand | null> {
    if (!command) {
      return Promise.resolve(null)
    }
    if (lastParseKey === command && lastParsePromise !== null) {
      return lastParsePromise
    }
    lastParseKey = command
    lastParsePromise = parseUncached(command)
    return lastParsePromise
  },
}
