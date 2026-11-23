export const UNREAD_PART = '\uFFFC'

export type ShellDialect = 'posix' | 'powershell'
export type Stage = { pipeline: number; stage: number }

export type ReadRedirect = { op: string; target: string }

export type ReadCommand = {
  argv: string[]
  env: Array<{ name: string; value: string }>
  redirects: ReadRedirect[]
  text: string
  line: number
  cwd: string | undefined
  background: boolean
  stages: readonly Stage[]
  input: string | undefined
  inner: number[][]
  inputInner: number[]
  body: string | undefined
  dialect: ShellDialect
  around: string | undefined
  gates?: ReadonlyArray<readonly [number, number]> | undefined
  maybes?: readonly number[] | undefined
  substituted?: boolean | undefined
  called?: 'name' | 'block' | undefined
  handed?: string | undefined
}

export type Layer = {
  argv: string[]
  program: string
  wrappers: string[]
  env: Array<{ name: string; value: string }>
  opaque: string | undefined
  findRoots: string[] | undefined
}

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

export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export type SimpleCommand = {
  argv: string[]
  envVars: Array<{ name: string; value: string }>
  redirects: Redirect[]
  text: string
  globOperand?: true
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

export type CommandReading = ShellRead & {
  text: string
  dialect: ShellDialect
  exact: ParseForSecurityResult
}
