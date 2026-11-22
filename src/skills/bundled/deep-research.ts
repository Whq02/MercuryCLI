export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './deep-researchContent.js'
import { notBuilt } from '../../pi/holes.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
const DESCRIPTION =
  typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description
    : "deep-research — bundled skill"

export function registerDeepResearchSkill(): void {
  return notBuilt('src/skills/bundled/deep-research.ts:12')
}
