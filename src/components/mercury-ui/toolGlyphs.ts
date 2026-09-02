// ============================================================================
//  toolGlyphs — the Tool Glyph Registry.
//
//  A transcript row reads `● Read  SubstratePanel.tsx`. The dot is STATE
//  (running/done/errored — the honest-state spine); the name is text. Nothing
//  told the eye what KIND of thing happened, so scanning a long turn meant
//  reading every row's name. This adds the missing axis: one width-stable mark
//  per tool FAMILY, so shell work, reads, edits and delegations separate at a
//  glance without reading a word.
//
//  Three rules the registry exists to keep:
//
//  · NOT COLOR-ONLY. The GLYPH carries the family; `tone` is a supporting
//    hint that a monochrome profile can drop entirely, and `fallback` is the
//    two-letter text form for a profile that cannot render the glyph. The
//    family is always recoverable without colour.
//  · WIDTH-STABLE. Every mark is drawn from Geometric Shapes (U+25A0–25FF),
//    one well-supported block, and measures 1 cell under the canonical width
//    model — scripts/ui/prove-glyph-width.ts ratchets that, and none of them
//    is an exact codepoint of the status spine (● ○ ◐ ◉ ◌ ◇ ◆ ▲ ▸). Where a
//    family mark is the HOLLOW sibling of a solid spine glyph (△ beside ▲,
//    ▷ beside ▸) that is the deliberate axis rule, not a collision: solid
//    marks say STATE, hollow marks say KIND — two vocabularies, one visual
//    grammar.
//  · TOTAL. Every tool Mercury registers is classified HERE, by name, and
//    scripts/cockpit-interaction/prove-tool-projection.ts holds this table against the
//    REAL registry (getAllBaseTools), not a filename convention — the first
//    cut swept `TOOL_NAME = '…'` constants and silently missed eight
//    registered tools. A new tool cannot quietly inherit a default.
//
//  `build` is deliberately NOT a family — builds run through the shell, so
//  the name would have no referent. `test` IS one: Mercury ships a dedicated
//  Test tool (structured runs), a Journey tool (end-to-end verification) and
//  a Transaction record binding test/debug evidence — the verification
//  family has referents, and ruling 12 asked for it by name.
// ============================================================================

import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'

export type ToolFamily =
  | 'shell'
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'diff'
  | 'browser'
  | 'agent'
  | 'plan'
  | 'test'
  | 'memory'
  | 'system'
  | 'external'

/** The tone role a family wears, named as a token key so no surface writes a
 *  colour. Mutations lean on the identity accent, readings on the information
 *  role, and everything that merely acts stays secondary ink. */
export type ToolToneRole = 'accent' | 'info' | 'textSecondary'

export type ToolFamilyMark = {
  glyph: string
  /** Two-letter text form for profiles that cannot render the glyph. */
  fallback: string
  tone: ToolToneRole
  /** What the family means, in the operator's words. */
  label: string
}

export const TOOL_FAMILY_MARKS: Record<ToolFamily, ToolFamilyMark> = {
  shell: { glyph: '▰', fallback: 'sh', tone: 'textSecondary', label: 'shell' },
  read: { glyph: '▤', fallback: 'rd', tone: 'info', label: 'read' },
  search: { glyph: '▽', fallback: 'se', tone: 'info', label: 'search' },
  edit: { glyph: '▨', fallback: 'ed', tone: 'accent', label: 'edit' },
  write: { glyph: '▣', fallback: 'wr', tone: 'accent', label: 'write' },
  diff: { glyph: '◧', fallback: 'df', tone: 'info', label: 'review' },
  browser: { glyph: '◵', fallback: 'wb', tone: 'textSecondary', label: 'web' },
  agent: { glyph: '△', fallback: 'ag', tone: 'accent', label: 'delegation' },
  plan: { glyph: '▦', fallback: 'pl', tone: 'info', label: 'planning' },
  test: { glyph: '▧', fallback: 'ts', tone: 'info', label: 'verify' },
  memory: { glyph: '▱', fallback: 'me', tone: 'info', label: 'memory' },
  system: { glyph: '▥', fallback: 'sy', tone: 'textSecondary', label: 'system' },
  external: { glyph: '▷', fallback: 'ex', tone: 'textSecondary', label: 'external' },
}

/**
 * Every registered tool, by name. Total by contract — the prover reads the
 * live pool and fails on any name missing here, so a tool cannot ship without
 * an operator-visible family.
 */
export const TOOL_FAMILY_BY_NAME: Record<string, ToolFamily> = {
  // shell — where Mercury runs commands and code
  Bash: 'shell',
  PowerShell: 'shell',
  REPL: 'shell',
  Launch: 'shell', // launch profiles: run/debug through executors
  Workshop: 'shell', // code-execution cells on the owning runtime
  Eval: 'shell', // persistent Python/JS eval cells (retained kernels)
  // read
  Read: 'read',
  ReadMcpResourceTool: 'read',
  // search / navigate
  Glob: 'search',
  Grep: 'search',
  AstSearch: 'search', // syntax-aware pattern queries over the tree-sitter grammars — a search that reads structure
  Inspect: 'search',
  LSP: 'search', // dominant use is queries; its mutating ops paint the change view (diff grammar)
  ToolSearch: 'search',
  // edit
  Edit: 'edit',
  AstEdit: 'edit', // syntax-aware rewrites — an edit addressed by structure instead of text
  NotebookEdit: 'edit',
  Structure: 'edit', // structural codemods — proposes and applies edits
  // write / create
  Write: 'write',
  SendUserFile: 'write',
  // diff / review
  ApolloReview: 'diff', // multi-agent code review — findings land as review records
  ChangeSet: 'diff',
  Git: 'diff', // the typed work graph: status, hunks, review records
  Transaction: 'diff', // evidence records reviewed to a verdict
  // browser / web
  Browser: 'browser',
  ProviderSearch: 'browser', // web search through a provider's native backend — WebSearch's sibling door
  WebFetch: 'browser',
  WebSearch: 'browser',
  // agent / delegation / coordination
  Agent: 'agent',
  Brief: 'agent',
  contract: 'agent', // the abide door onto the session's advisory contract (coordination vocabulary; lowercase by its own registered name)
  LaunchFleet: 'agent',
  SendMessage: 'agent',
  SendUserMessage: 'agent',
  Task: 'agent',
  TeamBrief: 'agent',
  TeamCreate: 'agent',
  TeamDelete: 'agent',
  Workflow: 'agent',
  // test / verify
  Test: 'test', // structured test runs
  Journey: 'test', // end-to-end application verification
  // planning / tasks / scheduling
  CronCreate: 'plan',
  CronDelete: 'plan',
  CronList: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  Monitor: 'plan',
  ScheduleWakeup: 'plan',
  Skill: 'plan',
  Sleep: 'plan',
  TaskCreate: 'plan',
  TaskGet: 'plan',
  TaskList: 'plan',
  TaskOutput: 'plan',
  TaskStop: 'plan',
  TaskUpdate: 'plan',
  TodoWrite: 'plan',
  // memory / context
  RememberLesson: 'memory',
  Retain: 'memory',
  Recall: 'memory',
  Reflect: 'memory',
  Correct: 'memory',
  RecordConvention: 'memory',
  // system / diagnostic
  AskUserQuestion: 'system',
  Checkpoint: 'system',
  Debug: 'system',
  EnterWorktree: 'system',
  ExitWorktree: 'system',
  Rewind: 'system',
  Service: 'system',
  SetTier: 'system',
  StructuredOutput: 'system',
  // external integration
  ArtifactsList: 'external',
  Aseprite: 'external', // somebody else's editor — the bridge drives it
  Blender: 'external', // somebody else's app — the bridge drives it
  Godot: 'external', // somebody else's engine — exactly what the family says
  Unity: 'external', // somebody else's engine — the bridge drives it
  ListMcpResourcesTool: 'external',
  PushNotification: 'external',
}

/**
 * The family for a tool name. An MCP tool arrives as `mcp__server__name` and
 * is external by construction — it is somebody else's integration, which is
 * exactly what the family says. An unregistered local name falls to `system`
 * rather than rendering nothing; the prover is what keeps that branch
 * unreachable for tools Mercury itself ships.
 */
export function toolFamilyFor(toolName: string): ToolFamily {
  const known = TOOL_FAMILY_BY_NAME[toolName]
  if (known) return known
  if (toolName.startsWith('mcp__')) return 'external'
  return 'system'
}

export function toolMarkFor(toolName: string): ToolFamilyMark {
  return TOOL_FAMILY_MARKS[toolFamilyFor(toolName)]
}

/** Resolve a family's tone against the live token layer. Kept here so no
 *  surface maps a family to a colour on its own. */
export function toolToneFor(
  toolName: string,
  tokens: MercuryThemeTokens,
): string {
  return tokens[toolMarkFor(toolName).tone]
}
