export function approvalScopeWords(origin: string): string[] {
  return [
    `Yes approves ${origin} for this session: Mercury drives any page on it without asking again.`,
    'Pages it links or redirects to are read (text, tree, console, screenshots) without asking; the first act on one asks.',
    'A new origin opened by address is asked by name.',
  ]
}

export function crossingScopeWords(origin: string): string[] {
  return [
    `Mercury has already read this page — reads never ask; this is the first act on ${origin}.`,
    `Yes approves ${origin} for this session, as a first visit would.`,
  ]
}

export const APPROVAL_RULE_LINE =
  'approvals: an origin you approve is driven for the session (every page on it); pages it links or redirects to are read without asking and the first act on one asks; a new origin opened by address asks by name'

export const INSTALLED_NOT_DRIVEN = 'not driven: it is your app; the tool drives Chrome for Testing'

export function checkedRuleContent(permissionResult: unknown, input: unknown): string | null {
  if ((input as { op?: string } | null)?.op === 'provision') return null
  const suggestions = (permissionResult as { suggestions?: Array<{ type?: string; rules?: Array<{ ruleContent?: string }> }> } | null)?.suggestions
  const content = suggestions?.find(suggestion => suggestion.type === 'addRules')?.rules?.[0]?.ruleContent
  if (typeof content !== 'string') return null
  const origin = content.startsWith('origin:') ? content.slice('origin:'.length) : content.startsWith('secret:') ? content.slice(content.indexOf('@') + 1) : ''
  return origin.startsWith('http') ? content : null
}
