import type { Unbuilt } from '../../pi/holes.js'

export type TsNode = Unbuilt

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
