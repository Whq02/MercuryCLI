export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import skillMd from './image-generation/SKILL.md'
import ref_references_families_md from './image-generation/references/families.md'
import ref_references_pixel_art_md from './image-generation/references/pixel-art.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  "references/families.md": ref_references_families_md,
  "references/pixel-art.md": ref_references_pixel_art_md,
}
