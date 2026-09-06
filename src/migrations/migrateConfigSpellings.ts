
export const RETIRED_GLOBAL_CONFIG_KEYS: Readonly<Record<string, string>> = {
  lastPlanModeUse: 'lastStrategyModeUse',
}

export const DROPPED_GLOBAL_CONFIG_KEYS: readonly string[] = [
  'clientDataCache',
  'additionalModelOptionsCache',
  'startupPrefetchedAt',
]

export const RETIRED_PROJECT_CONFIG_KEYS: Readonly<Record<string, string>> = {
  hasClaudeMdExternalIncludesApproved: 'hasExternalIncludesApproved',
  hasClaudeMdExternalIncludesWarningShown: 'hasExternalIncludesWarningShown',
}

export function rewriteRetiredKeys<T extends object>(
  record: T,
  table: Readonly<Record<string, string>>,
): T {
  const raw = record as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  for (const [retired, current] of Object.entries(table)) {
    if (!(retired in raw)) continue
    next ??= { ...raw }
    if (next[current] === undefined) next[current] = next[retired]
    delete next[retired]
  }
  return next === null ? record : (next as T)
}

export function dropRetiredKeys<T extends object>(record: T, dropped: readonly string[]): T {
  const raw = record as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  for (const key of dropped) {
    if (!(key in raw)) continue
    next ??= { ...raw }
    delete next[key]
  }
  return next === null ? record : (next as T)
}

export function rewriteRetiredGlobalConfigKeys<T extends object>(config: T): T {
  return dropRetiredKeys(rewriteRetiredKeys(config, RETIRED_GLOBAL_CONFIG_KEYS), DROPPED_GLOBAL_CONFIG_KEYS)
}

export function rewriteRetiredProjectConfigKeys<T extends object>(
  projects: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!projects) return projects
  let next: Record<string, T> | null = null
  for (const [key, record] of Object.entries(projects)) {
    const rewritten = rewriteRetiredKeys(record, RETIRED_PROJECT_CONFIG_KEYS)
    if (rewritten === record) continue
    next ??= { ...projects }
    next[key] = rewritten
  }
  return next === null ? projects : next
}
