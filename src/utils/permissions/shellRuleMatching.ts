/**
 * Shell rule grammar: exact / legacy-prefix / wildcard parsing and matching,
 * plus two suggestion builders. Rule content for shell tools is classified
 * into exactly one of three kinds, checked in a fixed order.
 */
import type { PermissionUpdate } from '../../types/permissions.js'

/** A parsed shell rule: exact command, legacy prefix, or wildcard pattern. */
export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

/** Count backslashes immediately before index `i`. */
function precedingBackslashes(text: string, i: number): number {
  let count = 0
  let j = i - 1
  while (j >= 0 && text[j] === '\\') {
    count++
    j--
  }
  return count
}

/**
 * Whether a pattern contains an unescaped asterisk AND does not end in the
 * legacy prefix form `:*`. The `:*` guard runs first: a legacy prefix rule is
 * not a wildcard rule. (The sole in-tree caller pre-checks `:*`, but this is a
 * public export other code may call directly, so the contract holds here.)
 */
export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(':*')) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashes(pattern, i) % 2 === 0) return true
  }
  return false
}

/** Count unescaped asterisks in a pattern. */
function countUnescapedWildcards(pattern: string): number {
  let count = 0
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && precedingBackslashes(pattern, i) % 2 === 0) count++
  }
  return count
}

/**
 * Classify rule content, checked in order: legacy prefix (ends in the
 * colon-star form with at least one non-newline character before it), then
 * wildcard (an unescaped asterisk, not ending in the colon-star form), then
 * exact.
 */
export function parsePermissionRule(rule: string): ShellPermissionRule {
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2)
    // The prefix run must be single-line and non-empty.
    if (prefix.length > 0 && !prefix.includes('\n')) {
      return { type: 'prefix', prefix }
    }
    // A bare colon-star, or a multi-line prefix, is neither prefix nor
    // wildcard (it ends in the colon-star form) → exact.
    return { type: 'exact', command: rule }
  }
  if (hasWildcards(rule)) {
    return { type: 'wildcard', pattern: rule }
  }
  return { type: 'exact', command: rule }
}

/** The prefix a rule would allowlist, or null when it is not a prefix rule. */
export function permissionRuleExtractPrefix(rule: string): string | null {
  const parsed = parsePermissionRule(rule)
  return parsed.type === 'prefix' ? parsed.prefix : null
}

// Placeholders for the two escaped forms, protected before regex escaping so
// they are never treated as wildcards. Chosen not to occur in commands.
const LITERAL_STAR = '\x00MERCURY_STAR\x00'
const LITERAL_BACKSLASH = '\x00MERCURY_BS\x00'
// The marker a live (unescaped) wildcard is reduced to before expansion.
const WILDCARD_MARK = '\x00MERCURY_WILD\x00'

const compiledCache = new Map<string, RegExp>()

/** Compile a wildcard pattern to an anchored, dot-all regex. */
function compileWildcard(rawPattern: string, caseInsensitive: boolean): RegExp {
  const cacheKey = `${caseInsensitive ? 'i:' : ''}${rawPattern}`
  const cached = compiledCache.get(cacheKey)
  if (cached) return cached

  const pattern = rawPattern.trim()
  const wildcardCountBeforeCollapse = countUnescapedWildcards(pattern)

  // Protect the escaped forms, then turn every remaining (live) asterisk into
  // a marker so regex escaping cannot touch it.
  let working = pattern
    .split('\\\\')
    .join(LITERAL_BACKSLASH)
    .split('\\*')
    .join(LITERAL_STAR)
    .split('*')
    .join(WILDCARD_MARK)

  // Escape all regex metacharacters in what remains (all literal now).
  working = working.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`)

  // Collapse runs of adjacent wildcard markers to one.
  const collapsed = new RegExp(`(?:${WILDCARD_MARK})+`, 'g')
  working = working.replace(collapsed, WILDCARD_MARK)

  // Trailing-argument optionality: a pattern ending in a space then the sole
  // unescaped wildcard makes the trailing arguments optional.
  const trailingOptional = ` ${WILDCARD_MARK}`
  let regexBody: string
  if (working.endsWith(trailingOptional) && wildcardCountBeforeCollapse === 1) {
    const head = working.slice(0, -trailingOptional.length)
    regexBody = `${head}(?: [\\s\\S]*)?`
  } else {
    regexBody = working.split(WILDCARD_MARK).join('[\\s\\S]*')
  }

  // Restore the protected literals as literal regex matches.
  regexBody = regexBody.split(LITERAL_STAR).join('\\*').split(LITERAL_BACKSLASH).join('\\\\')

  const flags = caseInsensitive ? 'i' : ''
  const compiled = new RegExp(`^${regexBody}$`, flags)
  compiledCache.set(cacheKey, compiled)
  return compiled
}

/** Match a wildcard pattern against a whole command string. */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  return compileWildcard(pattern, caseInsensitive).test(command)
}

/** A one-element allow-rule update for a local-settings destination. */
function localAllowUpdate(toolName: string, content: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName, ruleContent: content }],
    behavior: 'allow',
    destination: 'localSettings',
  } as PermissionUpdate
}

/** Suggest an allow rule for an exact command. */
export function suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, command)]
}

/** Suggest an allow rule for a prefix (serialised as the colon-star form). */
export function suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
  return [localAllowUpdate(toolName, `${prefix}:*`)]
}
