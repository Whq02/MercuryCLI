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
