import { extractOutputRedirections, pipeSpans } from './commands.js'
import { parseCommandRaw, PARSE_ABORTED, type Node } from './parser.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'

type OutputRedirection = { target: string; operator: '>' | '>>' }

export interface IParsedCommand {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
  getTreeSitterAnalysis(): TreeSitterAnalysis | null
}

class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  private readonly pipes: Array<{ start: number; end: number }>
  private readonly analysis: TreeSitterAnalysis
  private readonly redirections: ReturnType<typeof extractOutputRedirections>

  constructor(command: string, root: Node) {
    this.originalCommand = command
    this.pipes = pipeSpans(root)
    this.analysis = analyzeCommand(root, command)
    this.redirections = extractOutputRedirections(command)
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    if (this.pipes.length === 0) return [this.originalCommand]
    const segments: string[] = []
    let start = 0
    for (const pipe of this.pipes) {
      segments.push(this.originalCommand.slice(start, pipe.start))
      start = pipe.end
    }
    segments.push(this.originalCommand.slice(start))
    return segments.map(segment => segment.trim()).filter(Boolean)
  }

  withoutOutputRedirections(): string {
    return this.redirections.commandWithoutRedirections
  }

  getOutputRedirections(): OutputRedirection[] {
    return this.redirections.redirections
  }

  getTreeSitterAnalysis(): TreeSitterAnalysis {
    return this.analysis
  }
}

export function buildParsedCommandFromRoot(command: string, root: Node): IParsedCommand {
  return new TreeSitterParsedCommand(command, root)
}

export const ParsedCommand = {
  async parse(command: string): Promise<IParsedCommand | null> {
    const root = await parseCommandRaw(command)
    if (!root || root === PARSE_ABORTED || root.type === 'ERROR') return null
    return buildParsedCommandFromRoot(command, root)
  },
}
