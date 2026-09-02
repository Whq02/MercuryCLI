
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
  return { valid: true }
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  filePatternTools: new Set(['Read', 'Write', 'Edit', 'Glob', 'NotebookRead', 'NotebookEdit']),
  bashPrefixTools: new Set(['Bash']),
  customValidation: new Map([
    ['WebSearch', makeSearchTermValidator('WebSearch')],
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
