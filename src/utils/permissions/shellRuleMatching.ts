import type { PermissionUpdate } from '../../types/permissions.js'

export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

function precedingBackslashes(text: string, i: number): number {
  let count = 0
  let j = i - 1
  while (j >= 0 && text[j] === '\\') {
    count++
    j--
  }
  return count
}

export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(':*')) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashes(pattern, i) % 2 === 0) return true
  }
  return false
}

function countUnescapedWildcards(pattern: string): number {
  let count = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashes(pattern, i) % 2 === 0) count++
  }
  return count
}

export function parsePermissionRule(rule: string): ShellPermissionRule {
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2)
    if (prefix.length > 0 && !prefix.includes('\n')) {
      return { type: 'prefix', prefix }
    }
    return { type: 'exact', command: rule }
  }
  if (hasWildcards(rule)) {
    return { type: 'wildcard', pattern: rule }
  }
  return { type: 'exact', command: rule }
}

export function permissionRuleExtractPrefix(rule: string): string | null {
  const parsed = parsePermissionRule(rule)
  return parsed.type === 'prefix' ? parsed.prefix : null
}

const LITERAL_STAR = '\x00MERCURY_STAR\x00'
const LITERAL_BACKSLASH = '\x00MERCURY_BS\x00'
const WILDCARD_MARK = '\x00MERCURY_WILD\x00'

const compiledCache = new Map<string, RegExp>()

function compileWildcard(rawPattern: string, caseInsensitive: boolean): RegExp {
  const cacheKey = `${caseInsensitive ? 'i:' : ''}${rawPattern}`
  const cached = compiledCache.get(cacheKey)
  if (cached) return cached

  const pattern = rawPattern.trim()
  const wildcardCountBeforeCollapse = countUnescapedWildcards(pattern)

  let working = pattern
    .split('\\\\')
    .join(LITERAL_BACKSLASH)
    .split('\\*')
    .join(LITERAL_STAR)
    .split('*')
    .join(WILDCARD_MARK)

  working = working.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`)

  const collapsed = new RegExp(`(?:${WILDCARD_MARK})+`, 'g')
  working = working.replace(collapsed, WILDCARD_MARK)

  const trailingOptional = ` ${WILDCARD_MARK}`
  let regexBody: string
  if (working.endsWith(trailingOptional) && wildcardCountBeforeCollapse === 1) {
    const head = working.slice(0, -trailingOptional.length)
    regexBody = `${head}(?: [\\s\\S]*)?`
  } else {
    regexBody = working.split(WILDCARD_MARK).join('[\\s\\S]*')
  }

  regexBody = regexBody.split(LITERAL_STAR).join('\\*').split(LITERAL_BACKSLASH).join('\\\\')

  const flags = caseInsensitive ? 'i' : ''
  const compiled = new RegExp(`^${regexBody}$`, flags)
  compiledCache.set(cacheKey, compiled)
  return compiled
}

export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  return compileWildcard(pattern, caseInsensitive).test(command)
}

function localAllowUpdate(toolName: string, content: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName, ruleContent: content }],
    behavior: 'allow',
    destination: 'localSettings',
  } as PermissionUpdate
}

export function suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, command)]
}

export function suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, `${prefix}:*`)]
}
