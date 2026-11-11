import type { ToolPermissionContext } from '../../Tool.js'

type RulesBySource = Record<string, readonly string[] | undefined>

const late = new Set<string>()
const granted = new Set<string>()
const keyOf = (source: string, spelling: string): string => `${source}\u0000${spelling}`

export function noteAllowRulesOfSettingsChange(before: ToolPermissionContext, after: ToolPermissionContext): void {
  const stood = (before.alwaysAllowRules ?? {}) as RulesBySource
  for (const [source, spellings] of Object.entries((after.alwaysAllowRules ?? {}) as RulesBySource)) {
    if (source === 'policySettings') continue
    const known = new Set(stood[source] ?? [])
    for (const spelling of spellings ?? []) {
      const key = keyOf(source, spelling)
      if (!known.has(spelling) && !granted.has(key)) late.add(key)
    }
  }
}

export function noteAllowRulesGranted(source: string, spellings: readonly string[]): void {
  for (const spelling of spellings) {
    const key = keyOf(source, spelling)
    granted.add(key)
    late.delete(key)
  }
}

export function forgetLateAllowRules(): void {
  late.clear()
  granted.clear()
}

export function allowRulesThatPreAuthorise(context: ToolPermissionContext): ToolPermissionContext {
  if (late.size === 0) return context
  const kept: Record<string, readonly string[]> = {}
  let dropped = false
  for (const [source, spellings] of Object.entries((context.alwaysAllowRules ?? {}) as RulesBySource)) {
    const standing = (spellings ?? []).filter(spelling => !late.has(keyOf(source, spelling)))
    dropped ||= standing.length !== (spellings ?? []).length
    kept[source] = standing
  }
  return dropped ? { ...context, alwaysAllowRules: kept as ToolPermissionContext['alwaysAllowRules'] } : context
}
