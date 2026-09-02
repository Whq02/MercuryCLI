import {
  clearBetaHeaderLatches,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
  clearSystemPromptSectionState,
} from '../bootstrap/state.js'

type SectionValue = string | null

export type SystemPromptSection = {
  name: string
  compute: () => SectionValue | Promise<SectionValue>
  computeKey: (() => string) | null
  cacheBreaking: boolean
}

export function systemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey: null, cacheBreaking: false }
}

export function keyedSystemPromptSection(
  name: string,
  computeKey: () => string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey, cacheBreaking: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
  reason: string,
): SystemPromptSection {
  void reason
  return { name, compute, computeKey: null, cacheBreaking: true }
}

export function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SectionValue[]> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async section => {
      const key = section.computeKey ? section.computeKey() : null
      if (!section.cacheBreaking) {
        const cached = cache.get(section.name)
        if (cached !== undefined && cached.key === key) return cached.value
      }
      const value = await section.compute()
      setSystemPromptSectionCacheEntry(section.name, value, key)
      return value
    }),
  )
}

export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
