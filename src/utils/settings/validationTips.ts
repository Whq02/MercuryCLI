import { PERMISSION_MODES } from '../permissions/PermissionMode.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ValidationTip = Unbuilt

type TipContext = Unbuilt

export const MODE_GLOSS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: 'asks before each action no rule already allows',
  implement: 'file edits inside the project go ahead without asking',
  dontAsk: 'never asks, what would have asked is refused',
  sovereign: 'no prompts at all, a deny rule still refuses',
  flow: "everything runs except sudo, git push and history rewrites, publishing and deploying, and writes outside the project (the temp folders and this run's own scratch aside), which ask",
  apollo: 'the pre-flight interview, then one build on its own',
}

const DEFAULT_MODE_SUGGESTION = `Valid modes: ${PERMISSION_MODES.map(mode => `"${mode}" (${MODE_GLOSS[mode]})`).join(', ')}`

export function getValidationTip(context: TipContext): ValidationTip | null {
  return notBuilt('src/utils/settings/validationTips.ts:89')
}
