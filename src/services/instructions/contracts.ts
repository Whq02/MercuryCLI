import type { FrontmatterData } from '../../utils/frontmatterParser.js'
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
  convention?: string
  offered?: string
  dormant?: InstructionDormancy
}

type InstructionDormancy = 'manual' | 'off' | 'unsupported' | 'unreadable'

export type InstructionRuleReading =
  | { kind: 'always' }
  | { kind: 'scoped'; globs: string[] }
  | { kind: 'offered'; description: string }
  | { kind: 'manual' }
  | { kind: 'off' }
  | { kind: 'unsupported'; detail: string }

export type InstructionRuleFormat = {
  accepts(fileName: string): boolean
  read(frontmatter: FrontmatterData, alone: boolean): InstructionRuleReading
}

export type InstructionFamily = 'native' | 'shared'

export type InstructionOrigin =
  | 'managed'
  | 'managed-rules'
  | 'user'
  | 'user-rules'
  | 'project-walk'

export type InstructionConvention = {
  readonly id: string
  readonly family: InstructionFamily
  readonly fallback?: boolean
  readonly label?: string
  readonly belowHome?: boolean
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
  folderOf?(filePath: string): string | null
  readonly rules?: InstructionRuleFormat
  ruleAnchor?(source: string): string
}

export type InstructionAdapter = {
  readonly id: 'mercury' | (string & {})
  conventionsFor(profile: InstructionProfile): InstructionConvention[]
}

export type InstructionProfileResolution = {
  requested: InstructionProfile
  requestedOrigin: InstructionProfileOrigin
  resolved: InstructionProfile
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
    | 'unreadable-rule-header'
    | 'unsupported-rule-activation'
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
  convention?: string
}
