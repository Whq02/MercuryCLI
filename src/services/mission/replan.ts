
export const MISSION_REPLAN_TRIGGERS = [
  'check-failed',
  'undeclared-dependency',
  'combination-unavailable',
  'symbol-moved',
  'incomplete-envelope',
  'restart-reconstruction',
  'reviewer-unmet-acceptance',
  'size-reassessed',
] as const
export type MissionReplanTrigger = (typeof MISSION_REPLAN_TRIGGERS)[number]

export function isMissionReplanTrigger(v: unknown): v is MissionReplanTrigger {
  return typeof v === 'string' && (MISSION_REPLAN_TRIGGERS as readonly string[]).includes(v)
}

export function classifyReplanNote(note: string): MissionReplanTrigger | null {
  const text = note.toLowerCase()
  if (/\btrigger:\s*([a-z-]+)/.test(text)) {
    const tagged = /\btrigger:\s*([a-z-]+)/.exec(text)?.[1]
    if (isMissionReplanTrigger(tagged)) return tagged
  }
  if (/(check|test|suite).{0,24}(fail|red)/.test(text)) return 'check-failed'
  if (/(shared owner|undeclared|conflict|same file)/.test(text)) return 'undeclared-dependency'
  if (/(unavailable|unqualified|no such model|tool missing)/.test(text)) return 'combination-unavailable'
  if (/(moved|renamed|no longer exists|not found)/.test(text)) return 'symbol-moved'
  if (/(incomplete|indeterminate|generation retired|no result)/.test(text)) return 'incomplete-envelope'
  if (/(restart|reconstruct|resume)/.test(text)) return 'restart-reconstruction'
  if (/(review|acceptance).{0,24}(unmet|missing|failed)/.test(text)) return 'reviewer-unmet-acceptance'
  if (/(smaller|larger|scope (grew|shrank)|split further)/.test(text)) return 'size-reassessed'
  return null
}
