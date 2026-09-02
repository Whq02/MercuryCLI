
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

const DEFAULT_MODE_SUGGESTION =
  'Valid modes: "default" (standard prompting), "implement" (file edits pre-approved), ' +
  '"strategy" (read-only analysis), "dontAsk" (skip prompts, deny instead), ' +
  '"sovereign" (bypass everything), "flow" (classifier-arbitrated), ' +
  '"scribe" (scribe sessions), "autopilot" (bypass posture; requires arming)'

function matchTip(context: TipContext): ValidationTip | null {
  if (context.path === 'permissions.defaultMode' && context.code === 'invalid_value') {
    return { suggestion: DEFAULT_MODE_SUGGESTION }
  }
  if (context.path === 'apiKeyHelper' && context.code === 'invalid_type') {
    return {
      suggestion:
        'apiKeyHelper must be a shell command that prints only the API key to stdout, e.g. "/usr/local/bin/print-api-key.sh"',
    }
  }
  if (context.path === 'cleanupPeriodDays' && context.code === 'too_small' && context.expected === '0') {
    return {
      suggestion:
        'cleanupPeriodDays must be 0 or greater. A positive number is the transcript retention period in days (default 30); 0 disables session persistence entirely — no transcripts are written and existing transcripts are deleted at startup',
    }
  }
  if (context.path.startsWith('env.') && context.code === 'invalid_type') {
    return {
      suggestion: 'Environment values must be strings — quote numbers and booleans, e.g. "MY_FLAG": "true"',
    }
  }
  if (
    (context.path === 'permissions.allow' || context.path === 'permissions.deny') &&
    context.code === 'invalid_type' &&
    context.expected === 'array'
  ) {
    return {
      suggestion:
        'Use an array of Tool(specifier) rules, e.g. ["Bash(npm run build)", "Edit(src/**)", "Read(~/docs/**)"]. The * character is the wildcard',
    }
  }
  if (context.path.includes('hooks') && context.code === 'invalid_type') {
    return {
      suggestion:
        'Hooks use a matcher plus a hooks array. The matcher is a STRING: a tool name, a pipe-separated list, or empty to match everything. Example: {"PreToolUse": [{"matcher": "Bash|Edit", "hooks": [{"type": "command", "command": "./check.sh"}]}]}',
    }
  }
  if (context.code === 'invalid_type' && context.expected === 'boolean') {
    return { suggestion: 'Use unquoted true or false, e.g. "verbose": true' }
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
  if (context.path === 'permissions.additionalDirectories' && context.code === 'invalid_type') {
    return {
      suggestion:
        'additionalDirectories must be an array of directory paths, e.g. ["/home/user/other-project"]. The --add-dir flag and the /add-dir command do the same thing',
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
