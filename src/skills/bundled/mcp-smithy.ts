export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './mcp-smithyContent.js'
import { notBuilt } from '../../pi/holes.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
const DESCRIPTION =
  typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description
    : "mcp-smithy — bundled skill"

export function registerMcpSmithySkill(): void {
  return notBuilt('src/skills/bundled/mcp-smithy.ts:12')
}
