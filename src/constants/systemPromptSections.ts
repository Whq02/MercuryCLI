import { notBuilt, type Unbuilt } from '../pi/holes.js'

type SectionValue = Unbuilt

type SystemPromptSection = Unbuilt

export function systemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return notBuilt('src/constants/systemPromptSections.ts:17')
}

export function keyedSystemPromptSection(
  name: string,
  computeKey: () => string | null,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return notBuilt('src/constants/systemPromptSections.ts:24')
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
  reason: string,
): SystemPromptSection {
  return notBuilt('src/constants/systemPromptSections.ts:32')
}

export function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SectionValue[]> {
  return notBuilt('src/constants/systemPromptSections.ts:41')
}

export function onSystemPromptSectionsCleared(listener: () => void): () => void {
  return notBuilt('src/constants/systemPromptSections.ts:68')
}

export function clearSystemPromptSections(): void {
  return notBuilt('src/constants/systemPromptSections.ts:73')
}
