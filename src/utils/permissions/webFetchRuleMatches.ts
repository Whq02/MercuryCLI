export function webFetchRuleMatches(ruleContent: string, requestContent: string): boolean {
  if (ruleContent === requestContent) return true
  if (!ruleContent.startsWith('domain:') || !requestContent.startsWith('domain:') || !ruleContent.includes('*')) return false
  const pattern = ruleContent
    .slice('domain:'.length)
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${pattern}$`, 'i').test(requestContent.slice('domain:'.length))
}
