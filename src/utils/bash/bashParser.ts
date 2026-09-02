
export type TsNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TsNode[]
}

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

const parserModule: ParserModule = {
  parse(): TsNode | null {
    return null
  },
}

const parserReady: Promise<void> = Promise.resolve()

export function ensureParserInitialized(): Promise<void> {
  return parserReady
}

export function getParserModule(): ParserModule {
  return parserModule
}
