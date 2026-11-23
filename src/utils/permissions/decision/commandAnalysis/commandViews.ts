import type { Node } from '../../../bash/parser.js'
import { parseForSecurityFromAst } from './exact.js'

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

function literalOf(node: Node): Word {
  if (hasDynamic(node)) return null
  switch (node.type) {
    case 'word':
      return node.text.replace(/\\([\s\S])/g, '$1')
    case 'number':
      return node.text
    case 'raw_string':
      return node.text.slice(1, -1)
    case 'string':
      return node.text.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
    case 'concatenation': {
      const parts = node.children.map(literalOf)
      return parts.some(part => part === null) ? null : parts.join('')
    }
    case 'command_name':
      return node.children[0] ? literalOf(node.children[0]) : node.text
    default:
      return null
  }
}

export function placedPath(path: string, stand: Stand): { path: string; folders: readonly string[] } {
  const form = /^~([+-])(?=\/|$)/.exec(path)
  if (form === null || (form[1] === '-' && stand.left.length === 0)) return { path, folders: stand.cwds }
  return { path: `.${path.slice(2)}`, folders: form[1] === '+' ? stand.cwds : stand.left }
}

export function commandViews<F>(rootNode: unknown, cwd: string, handedDown: (name: string, words: string[]) => F, enter: (folder: string, target: string) => string) {
  const views: View<F>[] = []
  let broken = false
  const feedOf = (node: Node): F | null => {
    if (node.type !== 'command') return null
    const said = node.children.filter(child => child.type !== 'command_name' && child.type !== 'variable_assignment' && child.type !== 'file_redirect' && child.type !== 'herestring_redirect').map(literalOf)
    const name = literalOf(node.children.find(child => child.type === 'command_name') ?? node)
    if (name === null || said.some(word => word === null)) return null
    return handedDown(name, said as string[])
  }
  const walk = (node: Node, scope: Scope, feed: Fed<F>): void => {
    switch (node.type) {
      case 'ERROR':
        broken = true
        for (const child of node.children) walk(child, scope, undefined)
        return
      case 'subshell':
      case 'command_substitution':
      case 'process_substitution': {
        const inner: Scope = { cwds: [...scope.cwds], left: [...scope.left], cwdKnown: scope.cwdKnown }
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, inner)
          else walk(child, inner, undefined)
        }
        return
      }
      case 'pipeline': {
        let fed = feed
        for (const child of node.children) {
          if (child.type === '|' || child.type === '|&') continue
          walk(child, scope, fed)
          fed = feedOf(child)
        }
        return
      }
      case 'redirected_statement': {
        const heredoc = node.children.find(child => child.type === 'heredoc_redirect')
        const body = heredoc?.children.find(child => child.type === 'heredoc_body')
        const text: Fed<F> = body === undefined ? undefined : hasDynamic(body) ? null : { said: [body.text] }
        const inner = node.children.find(child => child.type !== 'file_redirect' && child.type !== 'heredoc_redirect')
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, scope)
          else if (child.type === 'heredoc_redirect') {
            const passes = inner?.type === 'command' && literalOf(inner.children.find(part => part.type === 'command_name') ?? inner) === 'cat' && inner.children.filter(part => part.type !== 'command_name').length === 0
            for (const part of child.children) if (part.type === 'pipeline' || part.type === 'command' || part.type === 'list') walk(part, scope, passes ? text : null)
          } else walk(child, scope, text === undefined ? feed : text)
        }
        return
      }
      case 'command': {
        const argv: Word[] = []
        const redirects: View<F>['redirects'] = []
        let fed = feed
        for (const child of node.children) {
          if (child.type === 'variable_assignment') {
            for (const part of child.children) walk(part, scope, undefined)
            continue
          }
          if (child.type === 'file_redirect') {
            redirects.push(redirectOf(child))
            continue
          }
          if (child.type === 'herestring_redirect') {
            const said = child.children.filter(part => part.type !== '<<<').map(literalOf)
            fed = said.some(part => part === null) ? null : { said: [(said as string[]).join(' ')] }
            continue
          }
          argv.push(literalOf(child))
          walk(child, scope, undefined)
        }
        if (argv.some(word => word === null)) {
          const read = parseForSecurityFromAst(node.text, node)
          const own = read.kind === 'simple' ? read.commands.find(simple => simple.argv.length === argv.length && simple.argv[0] === argv[0]) : undefined
          if (own !== undefined) own.argv.forEach((word, index) => { argv[index] = word.includes('__MERCURY_UNKNOWN') ? null : word })
        }
        views.push({ argv, redirects, feed: fed, cwds: [...scope.cwds], left: [...scope.left], cwdKnown: scope.cwdKnown, text: node.text })
        const name = argv[0]
        delete scope.entered
        if (name === 'cd' || name === 'pushd') {
          const target = argv[1]
          if (argv.length !== 2 || target === null || target === undefined || target === '-' || target.startsWith('-')) scope.cwdKnown = false
          else {
            const place = placedPath(target, scope)
            const entered = [...new Set(place.folders.map(folder => enter(folder, place.path)))]
            const next = [...new Set([...scope.cwds, ...entered])]
            if (next.length > MAX_FOLDERS) scope.cwdKnown = false
            else {
              scope.entered = { folders: entered, from: scope.cwds }
              scope.left = [...new Set([...scope.left, ...scope.cwds])]
              scope.cwds = next
            }
          }
        } else if (name === 'popd') scope.cwdKnown = false
        return
      }
      default:
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, scope)
          else if (child.type === '&&' && scope.entered !== undefined) {
            scope.cwds = scope.entered.folders
            scope.left = scope.entered.from
            delete scope.entered
          } else walk(child, scope, undefined)
        }
    }
  }
  const loose: Array<{ op: string; target: Word; cwds: string[]; left: string[]; cwdKnown: boolean }> = []
  const redirectOf = (node: Node): { op: string; target: Word } => {
    const op = node.children.find(child => /^[<>&|]+$/.test(child.type))?.type ?? ''
    const target = node.children.filter(child => child.type !== 'file_descriptor' && !/^[<>&|]+$/.test(child.type))[0]
    return { op, target: target === undefined ? null : literalOf(target) }
  }
  function redirect(node: Node, scope: Scope): void {
    loose.push({ ...redirectOf(node), cwds: [...scope.cwds], left: [...scope.left], cwdKnown: scope.cwdKnown })
  }
  const root = asNode(rootNode)
  if (root !== null) walk(root, { cwds: [cwd], left: [], cwdKnown: true }, undefined)
  return { views, loose, broken }
}
