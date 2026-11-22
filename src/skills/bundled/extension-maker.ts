export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './extension-makerContent.js'
import { notBuilt } from '../../pi/holes.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
const DESCRIPTION =
  typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description
    : "extension-maker — bundled skill"

export function registerExtensionMakerSkill(): void {
  return notBuilt('src/skills/bundled/extension-maker.ts:12')
}
