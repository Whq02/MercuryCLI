import { PERMISSION_MODES } from '../permissions/PermissionMode.js'

type ValidationTip = {
  suggestion?: string
  docLink?: string
}

type TipContext = {
  path: string
  code: string
  expected?: string
  received?: unknown
  enumValues?: string[]
  message?: string
  value?: unknown
}

export const MODE_GLOSS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: 'asks before each action no rule already allows',
  implement: 'file edits inside the project go ahead without asking',
  dontAsk: 'never asks, what would have asked is refused',
  sovereign: 'no prompts at all, a deny rule still refuses',
  flow: "everything runs except sudo, git push and history rewrites, publishing and deploying, and writes outside the project (the temp folders and this run's own scratch aside), which ask",
  apollo: 'the pre-flight interview, then one build on its own',
}

const DEFAULT_MODE_SUGGESTION = `Valid modes: ${PERMISSION_MODES.map(mode => `"${mode}" (${MODE_GLOSS[mode]})`).join(', ')}`

export function getValidationTip(context: TipContext): ValidationTip | null {
  const { path, code, expected, received, enumValues } = context

  if (path === 'guardrails.mode' && code === 'invalid_value') {
    return { suggestion: DEFAULT_MODE_SUGGESTION }
  }

  if (path === 'credentials.keyCommand' && code === 'invalid_type') {
    return {
      suggestion: 'Provide a shell command string that outputs your API key (e.g. "/path/to/get-api-key.sh")',
    }
  }

  if (path === 'records.retentionDays' && code === 'too_small') {
    return {
      suggestion: 'Use a non-negative number of days for the recording retention window; 0 turns transcript writing off while transcripts already on disk stay',
    }
  }

  if (path.startsWith('environment.values.') && code === 'invalid_type') {
    return {
      suggestion: 'Environment variable values must be strings; quote numbers and booleans (e.g. "true", "8080")',
    }
  }

  if (
    (path === 'guardrails.allow' || path === 'guardrails.ask' || path === 'guardrails.deny') &&
    code === 'invalid_type'
  ) {
    return {
      suggestion: 'Use an array of permission rules in "Tool(specifier)" form, such as ["Bash(npm test)", "Read(src/**)"]',
    }
  }

  if ((path === 'hooks' || path.startsWith('hooks.')) && code === 'invalid_type') {
    return {
      suggestion: 'Hooks must be an object mapping event names to arrays of matcher entries with a match string and hook commands',
    }
  }

  if (path === '' && code === 'invalid_type' && expected === 'object' && received === 'null') {
    return {
      suggestion: 'Ensure the settings file contains a valid JSON object (for example: {})',
    }
  }

  if (code === 'invalid_type' && expected === 'boolean') {
    return {
      suggestion: 'Use an unquoted boolean value: true or false',
    }
  }

  if (code === 'unrecognized_keys') {
    return {
      suggestion: 'Check for typos, or consult the settings documentation for the supported fields',
    }
  }

  if (code === 'invalid_value' && enumValues && enumValues.length > 0) {
    return {
      suggestion: `Valid values: ${enumValues.map(value => `"${value}"`).join(', ')}`,
    }
  }

  return null
}
