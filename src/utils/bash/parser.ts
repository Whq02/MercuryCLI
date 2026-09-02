/**
 * The bash parse facade: the thin entry the rest of the harness calls for a
 * structural parse.
 *
 * The structural parser lane is not shipped in this build (ruled final for
 * the): both entry points answer "no parse" after their guards and
 * every caller takes the legacy tokenizer path. Only the node shape and the
 * two entries survive here; the slice spec is the archive should the lane
 * ever be rebuilt.
 */
import type { TsNode } from './bashParser.js'

/** The AST node type consumers import from this facade. */
export type Node = TsNode

/** The full-parse result shape. */
export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

/** Commands longer than this are never parsed (applies to both entries). */
const MAX_PARSEABLE_COMMAND_LENGTH = 10_000

/**
 * The "attempted and gave up" sentinel: the parser was available but hit its
 * time or node budget (or failed internally). Callers MUST fail closed on
 * it — it is never a licence to take the legacy path, because adversarial
 * input can trigger it deliberately.
 */
export const PARSE_ABORTED: unique symbol = Symbol('PARSE_ABORTED')

/**
 * Full parse: root node plus the first command-bearing node and its leading
 * environment assignments. Null for an empty command, an over-length
 * command, or when no parse is available — which in this build is every
 * command (see the module comment).
 */
export async function parseCommand(command: string): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_PARSEABLE_COMMAND_LENGTH) {
    return null
  }
  // No parser lane in this build: no parse is attempted.
  return null
}

/**
 * Raw parse: just the root node, null, or the abort sentinel. In this build
 * the answer is null for every command that passes the guards.
 */
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_PARSEABLE_COMMAND_LENGTH) {
    return null
  }
  // No parser lane in this build: no parse is attempted.
  return null
}
