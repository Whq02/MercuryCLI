
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

export type ToolToneRole = 'accent' | 'info' | 'textSecondary'

export type ToolFamilyMark = {
  glyph: string
  fallback: string
  tone: ToolToneRole
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

export const TOOL_FAMILY_BY_NAME: Record<string, ToolFamily> = {
  Bash: 'shell',
  PowerShell: 'shell',
  REPL: 'shell',
  Launch: 'shell',
  Workshop: 'shell',
  Eval: 'shell',
  Read: 'read',
  ReadMcpResource: 'read',
  Glob: 'search',
  Grep: 'search',
  AstSearch: 'search',
  Inspect: 'search',
  LSP: 'search',
  ToolSearch: 'search',
  Edit: 'edit',
  AstEdit: 'edit',
  NotebookEdit: 'edit',
  Structure: 'edit',
  Write: 'write',
  SendUserFile: 'write',
  ApolloReview: 'diff',
  ChangeSet: 'diff',
  Git: 'diff',
  Transaction: 'diff',
  Browser: 'browser',
  ProviderSearch: 'browser',
  WebFetch: 'browser',
  WebSearch: 'browser',
  Agent: 'agent',
  Brief: 'agent',
  Contract: 'agent',
  LaunchFleet: 'agent',
  SendMessage: 'agent',
  SendUserMessage: 'agent',
  Task: 'agent',
  TeamBrief: 'agent',
  TeamCreate: 'agent',
  TeamDelete: 'agent',
  Workflow: 'agent',
  Test: 'test',
  Journey: 'test',
  CronCreate: 'plan',
  CronDelete: 'plan',
  CronList: 'plan',
  EnterStrategyMode: 'plan',
  ExitStrategyMode: 'plan',
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
  RememberLesson: 'memory',
  Retain: 'memory',
  Recall: 'memory',
  Reflect: 'memory',
  Correct: 'memory',
  RecordConvention: 'memory',
  AskUserQuestion: 'system',
  Checkpoint: 'system',
  Debug: 'system',
  EnterWorktree: 'system',
  ExitWorktree: 'system',
  Rewind: 'system',
  Service: 'system',
  SetTier: 'system',
  StructuredOutput: 'system',
  ArtifactsList: 'external',
  Aseprite: 'external',
  Blender: 'external',
  Godot: 'external',
  Unity: 'external',
  ListMcpResources: 'external',
  PushNotification: 'external',
}

export function toolFamilyFor(toolName: string): ToolFamily {
  const known = TOOL_FAMILY_BY_NAME[toolName]
  if (known) return known
  if (toolName.startsWith('mcp__')) return 'external'
  return 'system'
}

export function toolMarkFor(toolName: string): ToolFamilyMark {
  return TOOL_FAMILY_MARKS[toolFamilyFor(toolName)]
}

export function toolToneFor(
  toolName: string,
  tokens: MercuryThemeTokens,
): string {
  return tokens[toolMarkFor(toolName).tone]
}
