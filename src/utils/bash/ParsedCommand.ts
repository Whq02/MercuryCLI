import { extractOutputRedirections, pipeSpans } from './commands.js'
import { parseValidCommandRoot } from '../permissions/decision/commandAnalysis/sequence.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

type OutputRedirection = { target: string; operator: '>' | '>>' }

type IParsedCommand = Unbuilt

class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  private readonly pipes: Array<{ start: number; end: number }>
  private readonly analysis: TreeSitterAnalysis
  private readonly redirections: ReturnType<typeof extractOutputRedirections>

  constructor(command: string, root: unknown) {
    notBuilt('src/utils/bash/ParsedCommand.ts:22')
  }

  toString(): string {
    return notBuilt('src/utils/bash/ParsedCommand.ts:29')
  }

  getPipeSegments(): string[] {
    return notBuilt('src/utils/bash/ParsedCommand.ts:33')
  }

  withoutOutputRedirections(): string {
    return notBuilt('src/utils/bash/ParsedCommand.ts:45')
  }

  getOutputRedirections(): OutputRedirection[] {
    return notBuilt('src/utils/bash/ParsedCommand.ts:49')
  }

  getTreeSitterAnalysis(): TreeSitterAnalysis {
    return notBuilt('src/utils/bash/ParsedCommand.ts:53')
  }
}

export function buildParsedCommandFromRoot(command: string, root: unknown): IParsedCommand {
  return new TreeSitterParsedCommand(command, root)
}

export const ParsedCommand: Unbuilt = unbuilt('src/utils/bash/ParsedCommand.ts:62')
