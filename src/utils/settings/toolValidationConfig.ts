import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type CustomValidationResult = Unbuilt

type ToolValidationConfig = {
  filePatternTools: ReadonlySet<string>
  bashPrefixTools: ReadonlySet<string>
  customValidation: ReadonlyMap<string, (content: string) => CustomValidationResult>
}

function makeSearchTermValidator(toolName: string): (content: string) => CustomValidationResult {
  return notBuilt('src/utils/settings/toolValidationConfig.ts:15')
}

function validateWebFetchContent(content: string): CustomValidationResult {
  return notBuilt('src/utils/settings/toolValidationConfig.ts:29')
}

const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  filePatternTools: new Set(['Read', 'Write', 'Edit', 'Glob', 'NotebookRead', 'NotebookEdit']),
  bashPrefixTools: new Set(['Bash']),
  customValidation: new Map([
    ['WebSearch', makeSearchTermValidator('WebSearch')],
    ['ProviderSearch', makeSearchTermValidator('ProviderSearch')],
    ['WebFetch', validateWebFetchContent],
  ]),
}

export function isFilePatternTool(name: string): boolean {
  return notBuilt('src/utils/settings/toolValidationConfig.ts:59')
}

export function isBashPrefixTool(name: string): boolean {
  return notBuilt('src/utils/settings/toolValidationConfig.ts:63')
}

export function getCustomValidation(name: string): ((content: string) => CustomValidationResult) | undefined {
  return TOOL_VALIDATION_CONFIG.customValidation.get(name)
}
