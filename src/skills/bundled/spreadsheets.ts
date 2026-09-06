import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './spreadsheetsContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
const DESCRIPTION =
  typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description
    : "spreadsheets — bundled skill"

export function registerSpreadsheetsSkill(): void {
  registerBundledSkill({
    name: "spreadsheets",
    description: DESCRIPTION,
    ...(typeof frontmatter['when-to-use'] === 'string' && frontmatter['when-to-use'].trim()
      ? { whenToUse: frontmatter['when-to-use'] }
      : {}),
    ...(typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].trim()
      ? { argumentHint: frontmatter['argument-hint'] }
      : {}),
    ...(String(frontmatter['disable-model-invocation'] ?? '').toLowerCase() === 'true'
      ? { disableModelInvocation: true }
      : {}),
    userInvocable: String(frontmatter['user-invocable'] ?? '').toLowerCase() !== 'false',
    ...(Object.keys(SKILL_FILES).length > 0 ? { files: SKILL_FILES } : {}),
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) parts.push(args)
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
