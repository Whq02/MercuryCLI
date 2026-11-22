import type { Unbuilt } from '../../../../pi/holes.js'

export const UNREAD_PART = '\uFFFC'

export type ShellDialect = 'posix' | 'powershell'
export type Stage = { pipeline: number; stage: number }

export type ReadRedirect = { op: string; target: string }

export type ReadCommand = Unbuilt

export type Layer = Unbuilt

export type ShellRead = {
  commands: ReadCommand[]
  pipelineSizes: number[]
  exported: Map<string, string[]>
  homes: readonly string[]
  unread: { why: string; text: string } | undefined
}

export type ReadWorld = {
  cwd: string | undefined
  home: string | undefined
  homesRoot: string
  ownNames: readonly string[]
  user?: string
  uid?: string
  windows?: boolean
  folderOf?: (word: string) => string | undefined
  returnsTo?: string
}

export type Redirect = Unbuilt

export type SimpleCommand = Unbuilt

export type ParseForSecurityResult = Unbuilt

export type CommandReading = ShellRead & {
  text: string
  dialect: ShellDialect
  exact: ParseForSecurityResult
}
