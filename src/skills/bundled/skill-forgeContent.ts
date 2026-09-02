import skillMd from './skill-forge/SKILL.md'
import ref_scripts_skill_lint_py from './skill-forge/scripts/skill_lint.py'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  "scripts/skill_lint.py": ref_scripts_skill_lint_py,
}
