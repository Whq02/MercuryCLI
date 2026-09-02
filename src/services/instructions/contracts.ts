// ============================================================================
//  instructions/contracts.ts — the typed contract of the ONE instruction
//  owner.
//
//  Repository instructions are a first-class Mercury capability: ONE
//  source-aware engine (engine.ts) discovers, orders, dedups, budgets and
//  composes instruction sources; CONVENTIONS (adapters/) tell it which file
//  names and homes a source family uses; the operator-selectable PROFILE
//  decides which families participate and in what precedence.
//
//  This module is types only — no I/O, no state. The engine is the only
//  lifecycle owner and consumers import it directly; established behavior
//  stays byte-compatible (the compat comparison oracle is retired).
// ============================================================================
import type { MemoryType } from '../../utils/memory/types.js'

/** The operator-selectable instruction profile. RUNTIME-owned — never
 *  inferred from a model name.
 *    native — THE Mercury contract (the default
 *             ): project scope composes Mercury-native sources (MERCURY.md
 *             · MERCURY.local.md · the project-home rules dirs) plus whatever
 *             a MERCURY.md EXPLICITLY @imports; a project without native
 *             material composes an empty project scope. Managed/user operator
 *             layers are retained.
 *    auto   — ACCEPTED INPUT ONLY (persisted settings compatibility): it
 *             resolves to `native` and the resolution records the mapping.
 *  (There is no `compat` escape hatch — wholesale CLAUDE-family composition;
 *  the value is not accepted anywhere.) */
export type InstructionProfile = 'auto' | 'native'

export const INSTRUCTION_PROFILES: readonly InstructionProfile[] = [
  'auto',
  'native',
]

/** Where a resolved profile came from (precedence low→high: default <
 *  session/operator < agent/role). */
export type InstructionProfileOrigin = 'default' | 'session' | 'agent'

/** One discovered instruction source. This IS the established
 *  MemoryFileInfo shape (oracle-pinned) plus additive, optional bundle tags
 *  — existing consumers are untouched. */
export type InstructionSourceEntry = {
  path: string
  type: MemoryType
  content: string
  /** Path of the file that @included this one. */
  parent?: string
  /** Frontmatter `paths:` globs (conditional rules). */
  globs?: string[]
  /** True when auto-injection transformed `content` (frontmatter strip, HTML
   *  comment strip, MEMORY.md truncation) so it does not match the bytes
   *  on disk; `rawContent` then holds the unmodified disk bytes. */
  contentDiffersFromDisk?: boolean
  rawContent?: string
  /** Which source family contributed this entry. */
  family?: InstructionFamily
  /** Which discovery stage produced it. */
  origin?: InstructionOrigin
  /** The instruction root whose chain composed this entry: the boot cwd
   *  for the project walk, the operator-added directory for an
   *  'additional-dir' entry. Absent on the managed/user/automem layers. */
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

/** A source convention: the file names + homes one family of repository
 *  instructions uses. Pure path planning — the engine owns all traversal,
 *  parsing, caching and composition. The project-config seam
 *  (src/utils/projectConfig.ts) is the only legitimate source of home names. */
export type InstructionConvention = {
  readonly id: string
  readonly family: InstructionFamily
  /** Ordered per-directory project-scope file candidates (absolute paths):
   *  e.g. [dir/MERCURY.md, dir/.mercury/MERCURY.md]. */
  projectDirFiles(dir: string): string[]
  /** Ordered per-directory rules directories (may be empty for families
   *  without a rules convention). */
  projectRulesDirs(dir: string): string[]
  /** The per-directory local (not-checked-in) file, if the family has one. */
  localDirFile(dir: string): string | null
  /** Every LOCAL candidate for a directory (FC-101): the convention's two
   *  halves are symmetric — `.mercury/MERCURY.local.md` is discovered
   *  exactly where `.mercury/MERCURY.md` is. Optional; the engine falls
   *  back to the singular localDirFile. */
  localDirFiles?(dir: string): string[]
  /** The user-scope file/rules dir (config home), if the family has them. */
  userFile(): string | null
  userRulesDir(): string | null
  /** The managed (system policy) file/rules dir, if the family has them. */
  managedFile(): string | null
  managedRulesDir(): string | null
  /** Family-specific exclusion (e.g. the instructionExcludes setting). */
  isExcluded(filePath: string, type: MemoryType): boolean
  /** Exact instruction file NAMES this family recognizes (for watch/
   *  invalidation classification). */
  readonly instructionFileNames: readonly string[]
  /** Path markers that classify rules files (e.g. `/.mercury/rules/`). */
  readonly rulesPathMarkers: readonly string[]
}

/** The narrow typed extension point for a runtime adapter. Exactly one is
 *  implemented (mercury); a later cross-harness adapter registers here —
 *  nothing else does. NO AGENTS.md parsing, no speculative adapters. */
export type InstructionAdapter = {
  readonly id: 'mercury' | (string & {})
  /** The conventions this adapter contributes, in low→high priority order
   *  for the resolved profile. */
  conventionsFor(profile: InstructionProfile): InstructionConvention[]
}

/** Why the resolved profile differs from (or confirms) the requested one. */
export type InstructionProfileResolution = {
  requested: InstructionProfile
  requestedOrigin: InstructionProfileOrigin
  resolved: InstructionProfile
  /** Set when the legacy `auto` input mapped to the native contract. */
  mapped?: 'auto-to-native'
}

/** One composition diagnostic — surfaced by /doctor and the bundle, NEVER
 *  auto-fixed (diagnostics must not rewrite instructions). */
export type InstructionDiagnostic = {
  kind:
    | 'missing-import-target' // an @import resolved to a path that does not exist
    | 'import-target-is-directory' // an @import resolved to a directory, not a file
    | 'import-depth-exceeded' // an @import chain hit MAX_INCLUDE_DEPTH
    | 'import-cycle' // an @import names one of its own ancestors
    | 'duplicate-content' // identical bytes composed twice; the copy was dropped
    | 'external-import-blocked' // an @import outside the project awaits approval
    | 'unsupported-import-type' // an @import target EXISTS but its extension is not a composable text type (FC-100)
  path: string
  /** The importing file, for import-chain diagnostics. */
  parent?: string
  detail?: string
}

/** The typed instruction bundle — the one queryable answer to "what
 *  repository instructions is this session operating under". */
export type InstructionBundle = {
  resolution: InstructionProfileResolution
  adapterId: string
  /** Ordered, source-tagged entries exactly as composed (low→high). */
  entries: InstructionBundleEntry[]
  /** Deterministic digest over ordered (path, contentDigest) pairs —
   *  unchanged files ⇒ unchanged digest, no recomposition. */
  bundleDigest: string
  /** Entry count actually composed (skipped/empty sources excluded). */
  composedCount: number
  /** Native-family sources dropped by identical-content deduplication
   *  (aliases and copies never compose twice). */
  skippedDuplicates: { path: string; family: InstructionFamily }[]
  /** Composition diagnostics (missing/cyclic imports, dropped duplicates)
   *  — read-only findings, never auto-applied. */
  diagnostics: InstructionDiagnostic[]
}

export type InstructionBundleEntry = {
  path: string
  type: MemoryType
  family: InstructionFamily
  origin: InstructionOrigin
  /** sha256 of the composed content. */
  contentDigest: string
  /** Bytes of composed content (bodies stay with the engine — bundle
   *  consumers get refs + digests, never a second copy). */
  contentLength: number
  parent?: string
  globs?: string[]
  /** The instruction root the entry came from (see InstructionSourceEntry). */
  root?: string
}
