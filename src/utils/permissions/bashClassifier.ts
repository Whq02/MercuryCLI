/**
 * Disabled stub for the semantic Bash-rule classifier. The feature is not
 * available in this build; these observable behaviours are fixed so callers
 * compile and behave predictably.
 */

/** The rule-content prefix persisted in settings. Contract data. */
export const PROMPT_PREFIX = 'prompt:'

/** A classifier verdict over a Bash command. */
export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

/** The behaviour a classifier rule expresses. */
export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

/** Build a prompt-rule content string: the prefix, a space, the trimmed description. */
export function createPromptRuleContent(description: string): string {
  return `${PROMPT_PREFIX} ${description.trim()}`
}

/** Feature-enabled predicate — always false in this build. */
export function isClassifierPermissionsEnabled(): boolean {
  return false
}

/** The three description accessors — always empty in this build. */
export function getBashPromptDenyDescriptions(_context?: unknown): string[] {
  return []
}
export function getBashPromptAskDescriptions(_context?: unknown): string[] {
  return []
}
export function getBashPromptAllowDescriptions(_context?: unknown): string[] {
  return []
}

/**
 * Classify a Bash command — always a non-match at high confidence, because
 * the feature is off. All six parameters are accepted and ignored.
 */
export async function classifyBashCommand(
  _command: string,
  _cwd: string,
  _descriptions: string[],
  _behavior: ClassifierBehavior,
  _signal: AbortSignal,
  _isNonInteractiveSession: boolean,
): Promise<ClassifierResult> {
  return {
    matches: false,
    confidence: 'high',
    reason: 'The semantic Bash-rule classifier is switched off in this build.',
  }
}
