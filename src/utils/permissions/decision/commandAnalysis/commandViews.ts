import type { Node } from '../../../bash/parser.js'
import { parseForSecurityFromAst } from './exact.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

type Word = string | null
type Stand = { cwds: readonly string[]; left: readonly string[] }
type Scope = { cwds: string[]; left: string[]; cwdKnown: boolean; entered?: { folders: string[]; from: string[] } }
type Fed<F> = F | { said: string[] } | null | undefined
type View<F> = { argv: Word[]; redirects: Array<{ op: string; target: Word }>; feed: Fed<F>; cwds: string[]; left: string[]; cwdKnown: boolean; text: string }

const DYNAMIC_KINDS: ReadonlySet<string> = new Set(['simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion', 'ansi_c_string', 'translated_string'])
const MAX_FOLDERS = 8

function asNode(value: unknown): Node | null {
  if (value && typeof value === 'object' && 'type' in value && 'children' in value) {
    return value as Node
  }
  return null
}

function hasDynamic(node: Node): boolean {
  return DYNAMIC_KINDS.has(node.type) || node.children.some(hasDynamic)
}

export function placedPath(path: string, stand: Stand): { path: string; folders: readonly string[] } {
  const form = /^~([+-])(?=\/|$)/.exec(path)
  if (form === null || (form[1] === '-' && stand.left.length === 0)) return { path, folders: stand.cwds }
  return { path: `.${path.slice(2)}`, folders: form[1] === '+' ? stand.cwds : stand.left }
}

export function commandViews<F>(rootNode: unknown, cwd: string, handedDown: (name: string, words: string[]) => F, enter: (folder: string, target: string) => string): Unbuilt {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/commandViews.ts:52')
}
