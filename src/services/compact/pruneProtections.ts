// ============================================================================
//  compact/pruneProtections — THE named pruning-protection law (spec 07-C1):
//  one module every pruning path imports, so "what may never be blanked"
//  has exactly one owner.
//
//  The protected classes (Mercury's analogues of the ratified list):
//    · SKILL RESULTS — a loaded skill IS the instructions the turn runs on;
//      blanking one changes behaviour mid-flight.
//    · SKILL-FILE READS — FileRead results whose path lives in a skills
//      estate (mercury-skills/, .mercury/skills/, extension skill dirs).
//    · THE ACTIVE PLAN/BRIEF REFERENCE — plan-mode and brief tools; their
//      results are the run's standing contract.
//  And the FLOOR: never blank a result whose replacement placeholder would
//  cost as much as it saves.
//
//  Consumers: the time-based clearing projection (microCompact) and the
//  aggregate tool-result budget (requestContextPlan unions the protected
//  names into its skip set). New pruning paths import THIS module.
// ============================================================================

/** Tool names whose results no pruning path may blank or replace. */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Skill',
  'Brief',
  'ExitPlanMode',
  'EnterPlanMode',
])

/** Path fragments that mark a FileRead as a skill-file read — tested against
 *  the NORMALISED path below, never the model's raw spelling. */
const SKILL_PATH_MARKS = ['mercury-skills/', '/skills/'] as const

/** The model's raw tool input keeps whatever spelling the platform gave it:
 *  every skill directory Mercury builds comes from node's join — backslashes
 *  on win32 — so a substring test of POSIX marks against the raw path
 *  protected NOTHING there, and the skill's reference material was blanked
 *  mid-session on Windows while the same read on macOS/Linux stayed
 *  (FN-015 rank 60). Separators fold to '/', case folds (win32 paths are
 *  case-insensitive; over-protection is the safe direction for a guard). */
function normalizedReadPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** Below this estimate the placeholder costs as much as the blanking saves
 *  — clearing is a net loss and the law forbids it. */
export const PLACEHOLDER_COST_FLOOR_TOKENS = 48

/**
 * The one predicate: may THIS tool's result be pruned? `input` is the
 * paired tool_use input when the caller has it (the FileRead path check
 * needs it; absence fails OPEN to protection only for skill-named tools).
 */
export function isProtectedFromPruning(
  toolName: string | undefined,
  input?: unknown,
): boolean {
  if (toolName === undefined) return false
  if (PROTECTED_TOOL_NAMES.has(toolName)) return true
  if (toolName === 'Read' || toolName === 'FileRead') {
    const path = (input as { file_path?: unknown } | undefined)?.file_path
    if (typeof path === 'string') {
      const normalized = normalizedReadPath(path)
      if (SKILL_PATH_MARKS.some(mark => normalized.includes(mark))) return true
    }
  }
  return false
}

/** The floor law as a predicate: true when blanking would not pay. */
export function isBelowPlaceholderFloor(estimatedTokens: number): boolean {
  return estimatedTokens <= PLACEHOLDER_COST_FLOOR_TOKENS
}
