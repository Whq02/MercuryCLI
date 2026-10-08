import { extractOutputRedirections, splitPipeSegments } from './commands.js'
import type { Node } from './parser.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'

type OutputRedirection = {
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
  private readonly source: string
  private readonly pipePositions: number[]
  private readonly redirections: RedirectionRecord[]
  private readonly analysis: TreeSitterAnalysis

  constructor(command: string, rootNode: Node) {
    this.originalCommand = command
    this.source = command
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
      segments.push(this.source.slice(start, position))
      start = position + 1
    }
    segments.push(this.source.slice(start))
    return segments.map(segment => segment.trim()).filter(segment => segment.length > 0)
  }

  withoutOutputRedirections(): string {
    if (this.redirections.length === 0) {
      return this.originalCommand
    }
    const ordered = [...this.redirections].sort((a, b) => b.startIndex - a.startIndex)
    let text = this.source
    for (const record of ordered) {
      text = text.slice(0, record.startIndex) + text.slice(record.endIndex)
    }
    return text.trim()
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

class RegexParsedCommand_DEPRECATED implements IParsedCommand {
  readonly originalCommand: string

  constructor(command: string) {
    this.originalCommand = command
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    try {
      return splitPipeSegments(this.originalCommand)
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
