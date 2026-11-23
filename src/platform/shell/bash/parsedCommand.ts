import { extractOutputRedirections, pipeSpans } from './commands.js'
import { parseValidCommandRoot } from '../../../permissions/rules/decision/command-analysis/sequence.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'

type OutputRedirection = { target: string; operator: '>' | '>>' }

type IParsedCommand = {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
  getTreeSitterAnalysis(): TreeSitterAnalysis
}

class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  private readonly pipes: Array<{ start: number; end: number }>
  private readonly analysis: TreeSitterAnalysis
  private readonly redirections: ReturnType<typeof extractOutputRedirections>

  constructor(command: string, root: unknown) {
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
      const piece = this.originalCommand.slice(start, pipe.start).trim()
      if (piece !== '') segments.push(piece)
      start = pipe.end
    }
    const tail = this.originalCommand.slice(start).trim()
    if (tail !== '') segments.push(tail)
    return segments
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

export function buildParsedCommandFromRoot(command: string, root: unknown): IParsedCommand {
  return new TreeSitterParsedCommand(command, root)
}

export const ParsedCommand: {
  parse(command: string): Promise<IParsedCommand | null>
} = {
  async parse(command: string): Promise<IParsedCommand | null> {
    const root = await parseValidCommandRoot(command)
    if (!root) return null
    return buildParsedCommandFromRoot(command, root)
  },
}
