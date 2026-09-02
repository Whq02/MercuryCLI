import type { MemoryType } from '../../utils/memory/types.js'

export type InstructionProfile = 'auto' | 'native'

export const INSTRUCTION_PROFILES: readonly InstructionProfile[] = [
  'auto',
  'native',
]

export type InstructionProfileOrigin = 'default' | 'session' | 'agent'

export type InstructionSourceEntry = {
  path: string
  type: MemoryType
  content: string
  parent?: string
  globs?: string[]
  contentDiffersFromDisk?: boolean
  rawContent?: string
  family?: InstructionFamily
  origin?: InstructionOrigin
  root?: string
}

export type InstructionFamily = 'native'

export type InstructionOrigin =
  | 'managed'
  | 'managed-rules'
  | 'user'
  | 'user-rules'
  | 'project-walk'
  | 'additional-dir'
  | 'automem'

export type InstructionConvention = {
  readonly id: string
  readonly family: InstructionFamily
  projectDirFiles(dir: string): string[]
  projectRulesDirs(dir: string): string[]
  localDirFile(dir: string): string | null
  localDirFiles?(dir: string): string[]
  userFile(): string | null
  userRulesDir(): string | null
  managedFile(): string | null
  managedRulesDir(): string | null
  isExcluded(filePath: string, type: MemoryType): boolean
  readonly instructionFileNames: readonly string[]
  readonly rulesPathMarkers: readonly string[]
}

export type InstructionAdapter = {
  readonly id: 'mercury' | (string & {})
  conventionsFor(profile: InstructionProfile): InstructionConvention[]
}

export type InstructionProfileResolution = {
  requested: InstructionProfile
  requestedOrigin: InstructionProfileOrigin
  resolved: InstructionProfile
  mapped?: 'auto-to-native'
}

export type InstructionDiagnostic = {
  kind:
    | 'missing-import-target'
    | 'import-target-is-directory'
    | 'import-depth-exceeded'
    | 'import-cycle'
    | 'duplicate-content'
    | 'external-import-blocked'
    | 'unsupported-import-type'
  path: string
  parent?: string
  detail?: string
}

export type InstructionBundle = {
  resolution: InstructionProfileResolution
  adapterId: string
  entries: InstructionBundleEntry[]
  bundleDigest: string
  composedCount: number
  skippedDuplicates: { path: string; family: InstructionFamily }[]
  diagnostics: InstructionDiagnostic[]
}

export type InstructionBundleEntry = {
  path: string
  type: MemoryType
  family: InstructionFamily
  origin: InstructionOrigin
  contentDigest: string
  contentLength: number
  parent?: string
  globs?: string[]
  root?: string
}
