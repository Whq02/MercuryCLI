import { createHash } from 'node:crypto'
import type { InstructionProfile } from '../../services/instructions/contracts.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import type { EffortValue } from '../../utils/effort.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'

export const AGENT_SPEC_VERSION = 1

export type AgentSpecFields = {
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  mcpServers?: unknown[]
  hooks?: unknown
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  instructionProfile?: InstructionProfile
  permissionMode?: PermissionMode
  maxTurns?: number
  background?: boolean
  initialPrompt?: string
  memory?: AgentMemoryScope
  isolation?: 'worktree'
  specVersion?: number
}

export const KNOWN_AGENT_KEYS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'skills',
  'mcpServers',
  'hooks',
  'color',
  'model',
  'effort',
  'instructionProfile',
  'permissionMode',
  'maxTurns',
  'background',
  'initialPrompt',
  'memory',
  'isolation',
  'specVersion',
] as const

export type AgentDiagnosticSeverity = 'error' | 'warning' | 'info'

export type AgentDiagnostic = {
  severity: AgentDiagnosticSeverity
  code: string
  message: string
  line?: number
  field?: string
}

export type FrontmatterEntrySpan = {
  key: string
  startLine: number
  endLine: number
  style: 'scalar' | 'flow-list' | 'block-seq' | 'nested' | 'empty'
}

export type AgentDocument = {
  raw: string
  newline: '\n' | '\r\n'
  hasFrontmatter: boolean
  frontmatterStart: number
  frontmatterEnd: number
  frontmatterLines: string[]
  entries: FrontmatterEntrySpan[]
  body: string
  fields: AgentSpecFields
  unknownKeys: string[]
  diagnostics: AgentDiagnostic[]
}

export type AgentFileIdentity = {
  filePath: string
  revision: string
}

export function revisionDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16)
}

export type AgentDocumentEdit = {
  set?: Partial<AgentSpecFields>
  remove?: (keyof AgentSpecFields)[]
  body?: string
}

export class AgentCodecPatchError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message)
    this.name = 'AgentCodecPatchError'
  }
}
