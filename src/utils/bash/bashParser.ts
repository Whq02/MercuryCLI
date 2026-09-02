/**
 * The bash structural-parser module boundary.
 *
 * The tree-sitter-shaped parsing surface is not shipped in this build (ruled
 * final for the): every consumer takes the legacy tokenizer path
 * and the security walker fails closed on "no tree". This file provides the
 * module's stable boundary only — the node shape, the shell keyword set, the
 * always-resolved initialiser and the module accessor — and the accessor's
 * parse answers null ("no trustworthy tree") for every input. The grammar
 * itself lives nowhere in the tree; the slice spec is its archive.
 */

/**
 * The tree node shape every AST consumer matches on. Offsets are UTF-8 BYTE
 * offsets, not JS string indices: consumers slice the command's UTF-8
 * buffer with these numbers.
 */
export type TsNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TsNode[]
}

/**
 * The shell reserved words. A keyword appearing as argv[0] indicates a
 * mis-parse and must be treated as unanalysable by consumers; the parser's
 * own command-name scan is gated by the same set.
 */
export const SHELL_KEYWORDS: Set<string> = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
])

type ParserModule = {
  parse(source: string, timeoutMs?: number): TsNode | null
}

// The parsing surface is absent in this build, so the module's parse yields
// null unconditionally; null must never be confused with "empty program".
const parserModule: ParserModule = {
  parse(): TsNode | null {
    return null
  },
}

// One pre-resolved promise, returned every time: there is no native module,
// no WASM and no I/O to wait for.
const parserReady: Promise<void> = Promise.resolve()

/** Idempotent warm-up; resolves immediately. */
export function ensureParserInitialized(): Promise<void> {
  return parserReady
}

/** The parser-module accessor; always succeeds and never returns null. */
export function getParserModule(): ParserModule {
  return parserModule
}
