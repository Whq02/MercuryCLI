import { color } from './color.js'
import { DEFAULT_THEME_SETTING } from './systemTheme.js'
import type { Theme, ThemeName } from './theme.js'


export type TreeNode = { [key: string]: unknown }

type TreeifyOptions = {
  showValues?: boolean
  hideFunctions?: boolean
  themeName?: ThemeName
  treeCharColors?: {
    treeChar?: keyof Theme
    key?: keyof Theme
    value?: keyof Theme
  }
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

function entriesOf(node: object, hideFunctions: boolean): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(node)) {
    if (hideFunctions && typeof value === 'function') continue
    entries.push([key, value])
  }
  return entries
}

export function treeify(obj: TreeNode, options?: TreeifyOptions): string {
  const showValues = options?.showValues ?? false
  const hideFunctions = options?.hideFunctions ?? false
  const themeName = options?.themeName ?? DEFAULT_THEME_SETTING
  const paintTree = makePainter(options?.treeCharColors?.treeChar, themeName)
  const paintKey = makePainter(options?.treeCharColors?.key, themeName)
  const paintValue = makePainter(options?.treeCharColors?.value, themeName)

  const lines: string[] = []
  const ancestors = new Set<object>()

  const walk = (node: object, prefix: string): void => {
    ancestors.add(node)
    const entries = entriesOf(node, hideFunctions)
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i]!
      const isLast = i === entries.length - 1
      const branch = paintTree(`${isLast ? BRANCH_LAST : BRANCH_TEE} `)
      const childPrefix = prefix + paintTree(`${isLast ? CONTINUE_SPACE : CONTINUE_LINE}  `)
      const isObject = typeof value === 'object' && value !== null

      if (isObject && !ancestors.has(value)) {
        const childEntries = entriesOf(value, hideFunctions)
        lines.push(`${prefix}${branch}${paintKey(key)}`)
        if (childEntries.length > 0) {
          walk(value, childPrefix)
        }
      } else if (showValues && value !== undefined) {
        const formatted = isObject ? '[Circular]' : String(value)
        const valueLines = formatted.split('\n')
        const firstLine = valueLines[0] ?? ''
        const label =
          key === ''
            ? paintValue(firstLine)
            : `${paintKey(key)}: ${paintValue(firstLine)}`
        lines.push(`${prefix}${branch}${label}`)
        for (let j = 1; j < valueLines.length; j++) {
          lines.push(`${childPrefix}${paintValue(valueLines[j]!)}`)
        }
      } else {
        lines.push(`${prefix}${branch}${paintKey(key)}`)
      }
    }
    ancestors.delete(node)
  }

  walk(obj, '')
  return lines.join('\n')
}
