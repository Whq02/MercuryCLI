import { PERMISSION_MODES } from '../permissions/PermissionMode.js'

export type ValidationTip = {
  suggestion?: string
  docLink?: string
}

export type TipContext = {
  path: string
  code: string
  expected?: string
  received?: string
  enumValues?: string[]
  message?: string
  value?: unknown
}

const MODE_GLOSS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: 'standard prompting',
  implement: 'file edits pre-approved',
  dontAsk: 'skip prompts, deny instead',
  sovereign: 'bypass everything',
  flow: 'classifier-arbitrated',
  apollo: 'the pre-flight interview, then one autonomous build',
}

const DEFAULT_MODE_SUGGESTION = `Valid modes: ${PERMISSION_MODES.map(mode => `"${mode}" (${MODE_GLOSS[mode]})`).join(', ')}`

function matchTip(context: TipContext): ValidationTip | null {
  if (context.path === 'guardrails.mode' && context.code === 'invalid_value') {
    return { suggestion: DEFAULT_MODE_SUGGESTION }
  }
  if (context.path === 'credentials.keyCommand' && context.code === 'invalid_type') {
    return {
      suggestion:
        'credentials.keyCommand must be a shell command that prints only the API key to stdout, e.g. "/usr/local/bin/print-api-key.sh"',
    }
  }
  if (context.path === 'records.retentionDays' && context.code === 'too_small' && context.expected === '0') {
    return {
      suggestion:
        'records.retentionDays must be 0 or greater. A positive number is the retention window for recordings and tool results in days (default 30); session transcripts are never aged out. 0 turns transcript writing off: no new transcript is written, and the ones already on disk stay',
    }
  }
  if (context.path.startsWith('environment.values.') && context.code === 'invalid_type') {
    return {
      suggestion: 'Environment values must be strings — quote numbers and booleans, e.g. "MY_FLAG": "true"',
    }
  }
  if (
    (context.path === 'guardrails.allow' || context.path === 'guardrails.ask' || context.path === 'guardrails.deny') &&
    context.code === 'invalid_type' &&
    context.expected === 'array'
  ) {
    return {
      suggestion:
        'Use an array of Tool(specifier) rules, e.g. ["Bash(npm run build)", "Bash(npm run *)", "Edit(src/**)", "Read(~/docs/**)"]. The * character is the wildcard; a space and a star end a "starts with" rule',
    }
  }
  if (context.path.includes('hooks') && context.code === 'invalid_type') {
    return {
      suggestion:
        'Hooks use a matcher plus a hooks array. The matcher is a STRING: a tool name, a pipe-separated list, or empty to match everything. Example: {"PreToolUse": [{"matcher": "Bash|Edit", "hooks": [{"type": "command", "command": "./check.sh"}]}]}',
    }
  }
  if (context.code === 'invalid_type' && context.expected === 'boolean') {
    return { suggestion: 'Use unquoted true or false, e.g. "engine": { "reasoning": true }' }
  }
  if (context.code === 'unrecognized_keys') {
    return { suggestion: 'Check for typos, or consult the settings documentation for the supported fields' }
  }
  if (context.code === 'invalid_value' && context.enumValues !== undefined && context.enumValues.length > 0) {
    return {}
  }
  if (
    context.code === 'invalid_type' &&
    context.expected === 'object' &&
    context.path === '' &&
    (context.received as unknown) === null
  ) {
    return {
      suggestion:
        'Check for missing commas, unmatched brackets, or trailing commas — a JSON validator can pinpoint the problem',
    }
  }
  return null
}

export function getValidationTip(context: TipContext): ValidationTip | null {
  const tip = matchTip(context)
  if (tip === null) return null
  if (
    tip.suggestion === undefined &&
    context.code === 'invalid_value' &&
    context.enumValues !== undefined &&
    context.enumValues.length > 0
  ) {
    tip.suggestion = `Valid values: ${context.enumValues.map(value => `"${value}"`).join(', ')}`
  }
  return tip
}
