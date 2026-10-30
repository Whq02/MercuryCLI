export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import skillMd from './image-generation/SKILL.md'
import ref_references_families_md from './image-generation/references/families.md'
import ref_references_pipelines_md from './image-generation/references/pipelines.md'
import ref_references_pixel_art_md from './image-generation/references/pixel-art.md'
import ref_references_sources_md from './image-generation/references/sources.md'
import ref_references_tools_md from './image-generation/references/tools.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  "references/families.md": ref_references_families_md,
  "references/pipelines.md": ref_references_pipelines_md,
  "references/pixel-art.md": ref_references_pixel_art_md,
  "references/sources.md": ref_references_sources_md,
  "references/tools.md": ref_references_tools_md,
}
