import { clearBetaHeaderLatches, clearSystemPromptSectionState, getSystemPromptSectionCache, setSystemPromptSectionCacheEntry } from '../bootstrap/state.js'

type SectionValue = string | null

type SystemPromptSection = {
  name: string
  compute: () => SectionValue | Promise<SectionValue>
  computeKey: (() => string | null) | null
  cacheBreaking: boolean
}

const clearListeners = new Set<() => void>()

export function systemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey: null, cacheBreaking: false }
}

export function keyedSystemPromptSection(
  name: string,
  computeKey: () => string | null,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey, cacheBreaking: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
  reason: string,
): SystemPromptSection {
  return { name, compute, computeKey: null, cacheBreaking: true }
}

export function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SectionValue[]> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async section => {
      const key = section.computeKey === null ? null : section.computeKey()
      const saved = section.cacheBreaking ? undefined : cache.get(section.name)
      if (saved !== undefined) {
        if (key === null || saved.key === key) return saved.value
        if (saved.byKey?.has(key)) {
          const earlier = saved.byKey.get(key) ?? null
          setSystemPromptSectionCacheEntry(section.name, earlier, key)
          return earlier
        }
      }
      const value = await section.compute()
      setSystemPromptSectionCacheEntry(section.name, value, key)
      return value
    }),
  )
}

export function onSystemPromptSectionsCleared(listener: () => void): () => void {
  clearListeners.add(listener)
  return () => {
    clearListeners.delete(listener)
  }
}

export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
  for (const listener of clearListeners) listener()
}
