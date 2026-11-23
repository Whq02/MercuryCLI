import { type UUID } from 'node:crypto'
import type { LSPServerManager } from '../../../integrations/lsp/LSPServerManager.js'
import { type EditRow } from '../../../integrations/lsp/workspaceEditApply.js'
import type { ToolUseContext } from '../../kit/tool.js'

type MercuryLspOperation =
  | 'diagnostics'
  | 'rename'
  | 'codeActions'
  | 'switchSourceHeader'
  | 'typeDefinition'
  | 'serverStatus'
  | 'workspaceDiagnostics'
  | 'pathRename'
  | 'fixDiagnostic'
  | 'formatDocument'
  | 'formatRange'
  | 'organizeImports'
  | 'capabilities'
  | 'rawRequest'
  | 'moveSymbol'

export type MercuryLspOpInput = {
  operation: MercuryLspOperation
  filePath: string
  line: number
  character: number
  endLine?: number
  endCharacter?: number
  newName?: string
  newPath?: string
  apply?: boolean
  actionId?: string
  actionIndex?: number
  paths?: string[]
  method?: string
  params?: string
  plan?: string
  kind?: string
  targetPath?: string
}

type MercuryOpEffect = {
  outcome: 'succeeded' | 'failed' | 'no-change' | 'indeterminate'
  changedPaths: string[]
  evidence: string
  details?: Record<string, unknown>
}

export type LspChangeViewFile = {
  file: string
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
  omittedHunks?: number
  changedLines: number
}

export type MercuryLspOpOutput = {
  result: string
  resultCount?: number
  fileCount?: number
  applied?: boolean
  effect: MercuryOpEffect
  changeView?: {
    state: 'proposed' | 'applied'
    action: string
    files: LspChangeViewFile[]
    refs: string[]
  }
  edits?: EditRow[]
  omittedEdits?: number
  plan?: string
}

export type OpEnv = {
  input: MercuryLspOpInput
  absolutePath: string
  cwd: string
  manager: LSPServerManager
  tool: { name: string; getPath?: (input: unknown) => string | undefined }
  context: ToolUseContext
  messageId?: UUID
  requestWritePermission?: (path: string) => Promise<boolean>
}
