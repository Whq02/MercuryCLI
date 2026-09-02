import { color } from '../components/design-system/color.js'
import type { Theme, ThemeName } from './theme.js'

/**
 * Renders a nested object as a tree of box-drawing characters, with
 * optional per-role theme colouring for the tree characters, the keys and
 * the values. Consumed by the validation-errors panel; the four rendered
 * literals ((empty), [Circular], [Array(n)], [Function]) are its UI copy.
 */

export type TreeNode = { [key: string]: unknown }

export type TreeifyOptions = {
  showValues?: boolean
  hideFunctions?: boolean
  themeName?: ThemeName
  treeCharColors?: {
    treeChar?: keyof Theme
    key?: keyof Theme
    value?: keyof Theme
  }
  /** Declared for compatibility; never read — colouring is driven by which colour roles were supplied. */
  useColors?: boolean
}

const BRANCH_TEE = '├─'
const BRANCH_LAST = '└─'
const CONTINUE_LINE = '│'
const CONTINUE_SPACE = ' '

type Painter = (text: string) => string

function makePainter(role: keyof Theme | undefined, theme: ThemeName): Painter {
  if (role === undefined) return text => text
  return color(role, theme)
}

export function treeify(obj: TreeNode, options?: TreeifyOptions): string {
  const showValues = options?.showValues ?? true
  const hideFunctions = options?.hideFunctions ?? false
  const theme = options?.themeName ?? 'dark'
  const paintTree = makePainter(options?.treeCharColors?.treeChar, theme)
  const paintKey = makePainter(options?.treeCharColors?.key, theme)
  const paintValue = makePainter(options?.treeCharColors?.value, theme)

  const keys = Object.keys(obj)
  if (keys.length === 0) {
    return paintValue('(empty)')
  }
  // A single anonymous string value renders as one bare branch line.
  if (keys.length === 1) {
    const only = keys[0] as string
    const value = obj[only]
    if (only.trim() === '' && typeof value === 'string') {
      return `${paintTree(BRANCH_LAST)} ${paintValue(value)}`
    }
  }

  const lines: string[] = []
  const visited = new WeakSet<object>()

  const renderNode = (node: TreeNode, prefix: string): void => {
    if (visited.has(node)) return
    visited.add(node)
    const nodeKeys = Object.keys(node).filter(key => !hideFunctions || typeof node[key] !== 'function')
    nodeKeys.forEach((key, index) => {
      const value = node[key]
      const isLast = index === nodeKeys.length - 1
      const branch = paintTree(isLast ? BRANCH_LAST : BRANCH_TEE)
      const isAnonymousKey = key.trim() === ''
      const keyPart = isAnonymousKey ? '' : ` ${paintKey(key)}`
      const separator = isAnonymousKey ? ' ' : ': '

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (visited.has(value as object)) {
          lines.push(`${prefix}${branch}${keyPart}${separator}${paintValue('[Circular]')}`)
          return
        }
        lines.push(`${prefix}${branch}${keyPart}`)
        const continuation = isLast ? CONTINUE_SPACE : paintTree(CONTINUE_LINE)
        renderNode(value as TreeNode, `${prefix}${continuation} `)
        return
      }
      if (Array.isArray(value)) {
        lines.push(`${prefix}${branch}${keyPart}${separator}${paintValue(`[Array(${value.length})]`)}`)
        return
      }
      if (!showValues) {
        lines.push(`${prefix}${branch}${keyPart}`)
        return
      }
      const rendered = typeof value === 'function' ? '[Function]' : String(value)
      lines.push(`${prefix}${branch}${keyPart}${separator}${paintValue(rendered)}`)
    })
  }

  renderNode(obj, '')
  return lines.join('\n')
}
