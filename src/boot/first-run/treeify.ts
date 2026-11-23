import { color } from '../../screen/theme/color.js'
import { DEFAULT_THEME_SETTING } from '../../screen/theme/systemTheme.js'
import type { Theme, ThemeName } from '../../screen/theme/theme.js'


export type TreeNode = { [key: string]: unknown }

type TreeifyOptions = {
  showValues?: boolean
  hideFunctions?: boolean
  useColors?: boolean
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
  const showValues = options?.showValues ?? true
  const hideFunctions = options?.hideFunctions ?? false
  const themeName = options?.themeName ?? DEFAULT_THEME_SETTING
  const paintTree = makePainter(options?.treeCharColors?.treeChar, themeName)
  const paintKey = makePainter(options?.treeCharColors?.key, themeName)
  const paintValue = makePainter(options?.treeCharColors?.value, themeName)

  const rootEntries = entriesOf(obj, hideFunctions)
  if (rootEntries.length === 0) return '(empty)'

  const lines: string[] = []

  const pushKeyValue = (
    prefix: string,
    branch: string,
    childPrefix: string,
    key: string,
    formatted: string,
  ): void => {
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
  }

  if (
    rootEntries.length === 1 &&
    rootEntries[0]![0] === '' &&
    typeof rootEntries[0]![1] === 'string'
  ) {
    const branch = paintTree(`${BRANCH_LAST} `)
    const childPrefix = paintTree(`${CONTINUE_SPACE}  `)
    pushKeyValue('', branch, childPrefix, '', rootEntries[0]![1])
    return lines.join('\n')
  }

  const visited = new Set<object>()

  const walk = (node: object, prefix: string): void => {
    visited.add(node)
    const entries = entriesOf(node, hideFunctions)
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i]!
      const isLast = i === entries.length - 1
      const branch = paintTree(`${isLast ? BRANCH_LAST : BRANCH_TEE} `)
      const childPrefix = prefix + paintTree(`${isLast ? CONTINUE_SPACE : CONTINUE_LINE}  `)

      if (Array.isArray(value)) {
        pushKeyValue(prefix, branch, childPrefix, key, `[Array(${value.length})]`)
      } else if (typeof value === 'object' && value !== null) {
        if (visited.has(value)) {
          pushKeyValue(prefix, branch, childPrefix, key, '[Circular]')
        } else {
          lines.push(`${prefix}${branch}${key === '' ? '' : paintKey(key)}`)
          walk(value, childPrefix)
        }
      } else if (showValues) {
        const formatted = typeof value === 'function' ? '[Function]' : String(value)
        pushKeyValue(prefix, branch, childPrefix, key, formatted)
      } else {
        lines.push(`${prefix}${branch}${key === '' ? '' : paintKey(key)}`)
      }
    }
  }

  walk(obj, '')
  return lines.join('\n')
}
