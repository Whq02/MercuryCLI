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
      suggestion: 'credentials.keyCommand must be a shell command that prints only the API key to stdout, e.g. "/usr/local/bin/print-api-key.sh"',
    }
  }

  if (path === 'records.retentionDays' && code === 'too_small') {
    return {
      suggestion: 'records.retentionDays must be 0 or greater. A positive number is the retention window for recordings and tool results in days (default 30); session transcripts are never aged out. 0 turns transcript writing off: no new transcript is written, and the ones already on disk stay',
    }
  }

  if (path.startsWith('environment.values.') && code === 'invalid_type') {
    return {
      suggestion: 'Environment values must be strings — quote numbers and booleans, e.g. "MY_FLAG": "true"',
    }
  }

  if (
    (path === 'guardrails.allow' || path === 'guardrails.ask' || path === 'guardrails.deny') &&
    code === 'invalid_type'
  ) {
    return {
      suggestion: 'Use an array of Tool(specifier) rules, e.g. ["Bash(npm run build)", "Bash(npm run *)", "Edit(src/**)", "Read(~/docs/**)"]. The * character is the wildcard; a space and a star end a "starts with" rule',
    }
  }

  if ((path === 'hooks' || path.startsWith('hooks.')) && code === 'invalid_type') {
    return {
      suggestion: 'Hooks are a map of event name to a list of entries; one entry is one hook with its own match. The match is a STRING: a tool name, a pipe-separated list, a regular expression, or * or empty to match everything. Example: {"tool.before": [{"match": "Bash|Edit", "run": "./check.sh"}]}',
    }
  }

  if (path === '' && code === 'invalid_type' && expected === 'object' && received === 'null') {
    return {
      suggestion: 'Check for missing commas, unmatched brackets, or trailing commas — a JSON validator can pinpoint the problem',
    }
  }

  if (code === 'invalid_type' && expected === 'boolean') {
    return {
      suggestion: 'Use unquoted true or false, e.g. "engine": { "reasoning": true }',
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
