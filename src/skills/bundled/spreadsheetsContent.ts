import skillMd from './spreadsheets/SKILL.md'
import ref_scripts_sheet_summary_py from './spreadsheets/scripts/sheet_summary.py'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  "scripts/sheet_summary.py": ref_scripts_sheet_summary_py,
}
