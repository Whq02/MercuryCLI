/**
 * Façade over the two bash command parsers, exposing pipe-segment and
 * output-redirection views of a command string.
 *
 * Two implementations sit behind one interface: an AST-backed one built from
 * a parse tree, and a deprecated tokenizer-backed fallback used whenever the
 * AST lane is unavailable. Callers depend on the interface only.
 */
import { extractOutputRedirections, splitCommandWithOperators } from './commands.js'
import type { Node } from './parser.js'
import { analyzeCommand, type TreeSitterAnalysis } from './treeSitterAnalysis.js'

/** An output redirection view: only the two output forms are exposed. */
export type OutputRedirection = {
  target: string
  operator: '>' | '>>'
}

/** The interface every parsed-command implementation exposes. */
export interface IParsedCommand {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
  /** The richer AST analysis — null on the fallback implementation. */
  getTreeSitterAnalysis(): TreeSitterAnalysis | null
}

/** A recorded redirection with the byte span it occupies in the source. */
type RedirectionRecord = {
  target: string
  operator: '>' | '>>'
  startIndex: number
  endIndex: number
}

/**
 * The AST-backed implementation.
 *
 * Byte-offset discipline (load-bearing): the parser reports UTF-8 BYTE
 * offsets while JS string slicing is by UTF-16 code units — they coincide
 * only for ASCII. All slicing therefore happens on the UTF-8 byte
 * representation of the command, decoded back afterwards; slicing the JS
 * string directly would land mid-token for any multi-byte command.
 */
class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  private readonly commandBytes: Buffer
  private readonly pipePositions: number[]
  private readonly redirections: RedirectionRecord[]
  private readonly analysis: TreeSitterAnalysis

  constructor(command: string, rootNode: Node) {
    this.originalCommand = command
    this.commandBytes = Buffer.from(command, 'utf8')
    // Everything is computed eagerly at construction; the accessors below
    // just hand the results back.
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
      start = position + 1 // step past the one-byte `|`
    }
    segments.push(this.commandBytes.subarray(start).toString('utf8'))
    // Empty spans are dropped; when pipe positions exist and every span trims
    // to empty, the legitimate result is an empty list.
    return segments.map(segment => segment.trim()).filter(segment => segment.length > 0)
  }

  withoutOutputRedirections(): string {
    if (this.redirections.length === 0) {
      return this.originalCommand
    }
    // Remove recorded spans highest-offset first so earlier spans stay valid.
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

/**
 * Collect the byte offset of every `|` operator, from every pipeline node in
 * the tree. The positions are sorted ascending before use: for a command
 * like `a | b && c | d` the outer pipeline's operator is visited before the
 * inner one, so the raw walk order is not source order, while segmentation
 * slices left to right.
 */
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

/**
 * Collect output redirections: file-redirect nodes carrying a `>` or `>>`
 * operator child (the first such child) and a plain-word target child. A
 * quoted target is not a word node and is deliberately not collected here.
 */
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

/**
 * The deprecated tokenizer-backed fallback. Its rejoin is lossy (original
 * spacing and quoting are not preserved) — accepted behaviour for this path.
 *
 * @deprecated Use the AST-backed implementation via `ParsedCommand.parse`
 * wherever a parse tree is available; this class remains as the fallback
 * path and for testing.
 */
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
    // Cheap short-circuit: nothing to strip without a `>` anywhere.
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

/**
 * Probe the AST lane once and memoize the answer: load the parser module
 * dynamically, parse a trivial known-good command, and report whether a tree
 * came back. Any thrown error means unavailable.
 */
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

/**
 * Build the AST-backed implementation directly from a caller-supplied parse
 * tree root, so a caller that already has the tree does not parse twice.
 */
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
      // A null tree or a throw falls through to the fallback below.
    }
  }
  return new RegexParsedCommand_DEPRECATED(command)
}

/**
 * A single-entry cache keyed on the exact previous command string. The key
 * is recorded before the parse starts, so concurrent identical calls share
 * one in-flight parse. The bound of one entry is deliberate: legacy callers
 * re-parse the same string several times per permission check, while a
 * larger cache would retain parsed-command instances.
 */
let lastParseKey: string | null = null
let lastParsePromise: Promise<IParsedCommand | null> | null = null

export const ParsedCommand = {
  /** Parse a command string; null only for a falsy (empty) command. */
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
