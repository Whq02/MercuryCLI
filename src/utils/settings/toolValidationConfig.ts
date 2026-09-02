/**
 * Which tools accept glob patterns / bash prefix wildcards in permission
 * rules, plus per-tool custom checks. The tool names and rule formats are
 * contract data — users' existing settings files were written against
 * them.
 */

export type CustomValidationResult = {
  valid: boolean
  error?: string
  suggestion?: string
  examples?: string[]
}

export type ToolValidationConfig = {
  filePatternTools: ReadonlySet<string>
  bashPrefixTools: ReadonlySet<string>
  customValidation: ReadonlyMap<string, (content: string) => CustomValidationResult>
}

/** Search-term rule content (WebSearch and ProviderSearch carry the same
 *  grammar); the factory keeps the error prose naming the actual tool. */
function makeSearchTermValidator(toolName: string): (content: string) => CustomValidationResult {
  return content => {
    if (content.includes('*') || content.includes('?')) {
      return {
        valid: false,
        error: `${toolName} rules do not support wildcards`,
        suggestion: 'Use exact search terms instead',
        examples: [`${toolName}(weather in tokyo)`, `${toolName}(typescript generics tutorial)`],
      }
    }
    return { valid: true }
  }
}

function validateWebFetchContent(content: string): CustomValidationResult {
  // WebFetch permissions are domain-scoped, never URL-scoped.
  if (content.includes('://') || content.startsWith('http')) {
    return {
      valid: false,
      error: 'WebFetch permissions use a domain format, not URLs',
      suggestion: 'Use the domain:hostname form',
      examples: ['WebFetch(domain:example.com)', 'WebFetch(domain:docs.example.com)'],
    }
  }
  if (!content.startsWith('domain:')) {
    return {
      valid: false,
      error: 'WebFetch rules require the domain: prefix',
      suggestion: 'Use the domain:hostname form',
      examples: ['WebFetch(domain:example.com)', 'WebFetch(domain:*.example.com)'],
    }
  }
  // Wildcards inside the domain (leading or trailing) are allowed.
  return { valid: true }
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  filePatternTools: new Set(['Read', 'Write', 'Edit', 'Glob', 'NotebookRead', 'NotebookEdit']),
  bashPrefixTools: new Set(['Bash']),
  customValidation: new Map([
    ['WebSearch', makeSearchTermValidator('WebSearch')],
    // ProviderSearch permission rules carry the same search-term content as
    // WebSearch rules, so they get the same check — without this row a
    // ProviderSearch(...) rule escaped the wildcard refusal entirely
    // (a permission-surface gap, not cosmetics).
    ['ProviderSearch', makeSearchTermValidator('ProviderSearch')],
    ['WebFetch', validateWebFetchContent],
  ]),
}

export function isFilePatternTool(name: string): boolean {
  return TOOL_VALIDATION_CONFIG.filePatternTools.has(name)
}

export function isBashPrefixTool(name: string): boolean {
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.has(name)
}

export function getCustomValidation(name: string): ((content: string) => CustomValidationResult) | undefined {
  return TOOL_VALIDATION_CONFIG.customValidation.get(name)
}
