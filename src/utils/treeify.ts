import { color } from './color.js'
import { DEFAULT_THEME_SETTING } from './systemTheme.js'
import type { Theme, ThemeName } from './theme.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type TreeNode = { [key: string]: unknown }

type TreeifyOptions = Unbuilt

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
  return notBuilt('src/utils/treeify.ts:32')
}
