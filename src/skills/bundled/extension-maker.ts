import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './extension-makerContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)
const DESCRIPTION =
  typeof frontmatter.description === 'string' && frontmatter.description.trim()
    ? frontmatter.description
    : "extension-maker — bundled skill"

export function registerExtensionMakerSkill(): void {
  registerBundledSkill({
    name: "extension-maker",
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
