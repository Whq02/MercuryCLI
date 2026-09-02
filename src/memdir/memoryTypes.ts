// ============================================================================
//  src/memdir/memoryTypes.ts — the four-type memory taxonomy and the prose
//  sections built from it. The taxonomy constrains memories to context NOT
//  derivable from the current project state.
//
//  The types prose is intentionally duplicated as full text rather than
//  generated from a shared spec, so per-mode edits never require reasoning
//  through conditional rendering. (The combined-mode variant is not built in
//  this snapshot — its only consumer is the dead combined prompt builder.)
// ============================================================================

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Maps a raw frontmatter value to a type; unknown and non-string degrade
 *  gracefully to undefined (legacy files carry no type field). */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return (MEMORY_TYPES as readonly string[]).includes(raw) ? (raw as MemoryType) : undefined
}

/** The frontmatter format block: every value is a double-brace placeholder. */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{short-kebab-case-slug}}',
  'description: {{one-line description used to decide relevance in future conversations — make it specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{the memory itself; for feedback and project memories, structure as the rule or fact, then a bold "Why:" line, then a bold "How to apply:" line}}',
  '```',
] as const

export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  '## Memory types',
  '',
  'Each memory is one of four types; the type constrains what belongs in it.',
  '- `user` — who the user is: role, goals, preferences, what they already know — save it on learning any such detail, so future collaboration fits them specifically (a senior engineer and a first-time coder are collaborated with differently). Never negative judgement of them, never detail irrelevant to the shared work.',
  '- `feedback` — how to approach the work. The most important type: record from BOTH correction ("no, not that way") AND confirmation ("perfect"; an unusual choice accepted) — corrections alone drift behaviour over-cautious — and always carry the why, so edge cases can be judged instead of rule-followed. Saved feedback means the same guidance never has to be given twice.',
  '- `project` — ongoing work, goals, deadlines, incidents not derivable from the code or the git history: who is doing what, why, by when. These decay fast — keep them current, and convert relative dates to absolute ("by Friday" becomes "by 2026-08-21").',
  '- `reference` — pointers to where information lives outside this project (a tracker project, a chat channel, a dashboard), so future conversations know where to look.',
] as const

export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save',
  '',
  '- Anything derivable from the project itself: code patterns, conventions, architecture, paths, git history and authorship, debugging fix recipes (the fix is in the code; the context is in the commit message).',
  '- Anything already documented in the project instruction estate (MERCURY.md and the guides it imports) — and durable project conventions the user STATES ("always use bun here") belong THERE, where every session loads them: record them in the estate and say where. Memory keeps what is personal to this collaboration, never a second copy of a shared project rule.',
  '- Ephemeral task details: in-progress work, temporary state, current-conversation context.',
  '',
  'These exclusions hold even when the user explicitly asks to save. Asked to remember a change list or an activity summary, ask instead what was surprising or non-obvious about it — that is the part worth keeping.',
] as const

/** Its own export, bullet marker included; the combined variant reuses it. */
export const MEMORY_DRIFT_CAVEAT =
  '- A memory can decay: it records the world at the moment it was written — treat it as input, not fact. Before answering from one, re-read what it describes; where memory and present observation disagree, the observation wins — correct or delete the memory rather than acting on it.'

export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## When to access memory',
  '- Access memory when it seems relevant or the user references prior work; when they explicitly ask you to check, recall, or remember something, you MUST.',
  '- Told to ignore memory, proceed as if MEMORY.md were empty: no remembered facts applied, cited, compared against, or mentioned.',
  MEMORY_DRIFT_CAVEAT,
] as const

export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending something from memory',
  '',
  'A memory that names a file, function, or flag establishes only that the name was real when written. Verify against the live tree before recommending — the path exists, the symbol is found — especially when the user is about to act on the answer. "The memory asserts X" and "X is true right now" are different claims. Questions about current or recent repository state are answered from the code and history, never from a remembered snapshot.',
] as const
