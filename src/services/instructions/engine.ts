// ============================================================================
//  instructions/engine.ts — the ONE instruction engine.
//
//  Owns, exactly once, for every execution path (main/headless/REPL/daemon/
//  generated agents/teammates/ACP children/resume/compaction):
//    - the discovery WALK (managed → user → one root chain per instruction
//      root: the boot cwd's ancestry, then each operator-added directory's →
//      memdir entrypoint), parameterized by source CONVENTIONS (adapters/)
//      — never by hard-wired file names;
//    - the memoized cache + its lifecycle (clear/reset + the one-shot
//      InstructionsLoaded hook reason);
//    - nested-directory + conditional-rule loading;
//    - content BUDGETING (the dynamic per-model large-file cap);
//    - prompt COMPOSITION (the instruction header + per-type descriptions);
//    - the typed InstructionBundle (source-tagged entries + digests).
//
//  Consumers import this module directly — there is no legacy-export facade.
//  The established byte contract survives (the composed prompt bytes are
//  unchanged by the re-organization); its era comparison oracle retired
//  after verifying against the committed goldens.
//
//  MEMORY_INSTRUCTION_PROMPT and the per-type description strings below are
//  MODEL-FACING WIRE BYTES under that contract — cache stability and the
//  goldens pin them; they change only in a deliberate prompt-contract cut,
//  never in a comment pass.
// ============================================================================
import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, parse, resolve } from 'path'

import {
  getAddedDirectories,
  getOriginalCwd,
  getSdkBetas,
  setAddedDirectories,
  setCachedInstructionPrompt,
} from '../../bootstrap/state.js'
import {
  filterInjectedMemoryFilesByRecall,
  getAutoMemEntrypoint,
  isAutoMemoryEnabled,
  relevantMemoryRecallEnabled,
} from '../../memdir/paths.js'
import { getCurrentProjectConfig } from '../../utils/config.js'
import {
  getContextWindowForModel,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from '../../utils/context.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { normalizePathForComparison } from '../../utils/file.js'
import { cacheKeys, type FileStateCache } from '../../utils/fileStateCache.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from '../../utils/hooks.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { adapterForProfile } from './adapters/index.js'
import type {
  InstructionBundle,
  InstructionBundleEntry,
  InstructionConvention,
  InstructionDiagnostic,
  InstructionFamily,
  InstructionOrigin,
  InstructionProfile,
  InstructionProfileResolution,
  InstructionSourceEntry,
} from './contracts.js'
import {
  clearExcludeResolutionMemo,
  pathInInstructionRoots,
  processConditionedRules,
  processInstructionFile,
  processRulesDir,
  safelyReadInstructionFileAsync,
} from './discovery.js'
import { resolveRequestedInstructionProfile } from './profile.js'

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

// Floor for the dynamic large-instruction-file cap. Historically the one
// static MAX_MEMORY_CHARACTER_COUNT; the cap now grows with the model's
// context window (getMaxMemoryCharacterCount) but never drops below this.
export const MIN_MEMORY_CHARACTER_COUNT = 40000

// An instruction file counts as "large" past this fraction of the model's
// context window (in characters, via the chars-per-token estimate).
export const MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO = 0.05

// The repo-wide rough token estimate: ~4 chars per token.
const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * The per-model "large file" cap, in characters:
 *   max(MIN_MEMORY_CHARACTER_COUNT,
 *       round(contextTokens * RATIO * charsPerToken)).
 * A 200k-window model sits exactly at the 40000 floor; a 1M-window model
 * scales up proportionally. A non-finite or non-positive resolved window
 * falls back to the default window before the formula runs. ONE ceiling
 * for the whole composition: every instruction root's files are measured
 * against this same cap (getLargeMemoryFiles runs over the composed union);
 * an added root never widens it.
 */
export function getMaxMemoryCharacterCount(
  model: string = getMainLoopModel(),
): number {
  const limit = getContextWindowForModel(model, getSdkBetas())
  const contextTokens =
    Number.isFinite(limit) && limit > 0 ? limit : MODEL_CONTEXT_WINDOW_DEFAULT
  return Math.max(
    MIN_MEMORY_CHARACTER_COUNT,
    Math.round(
      contextTokens * MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO * CHARS_PER_TOKEN_ESTIMATE,
    ),
  )
}

/**
 * Back-compat alias for the former static cap. Diagnostic/status surfaces that
 * display a single threshold continue to reference the floor; the actual
 * large-file gating (getLargeMemoryFiles) uses the dynamic per-model cap.
 */
export const MAX_MEMORY_CHARACTER_COUNT = MIN_MEMORY_CHARACTER_COUNT

/** The inspectable state of the LAST composition — resolution, adapter and
 *  dedup drops. Recomputed on every discovery-cache miss; surfaces (doctor,
 *  /memory, the bundle) read it beside the memoized entry list. */
type InstructionCompositionState = {
  resolution: InstructionProfileResolution
  adapterId: string
  skippedDuplicates: { path: string; family: InstructionFamily }[]
  /** Composition diagnostics (import findings + dropped duplicates) —
   *  read-only; surfaced by /health and the bundle, never auto-applied. */
  diagnostics: InstructionDiagnostic[]
  /** Why the last composition ran: an InstructionsLoadReason
   *  ('session_start' | 'compact' | …), 'cache-refresh' for a plain
   *  clearMemoryFileCaches reload, or 'external-check' for the
   *  forceIncludeExternal approval pass. */
  loadReason: string
}

let lastComposition: InstructionCompositionState = {
  resolution: {
    requested: 'auto',
    requestedOrigin: 'default',
    resolved: 'native',
    mapped: 'auto-to-native',
  },
  adapterId: 'mercury',
  skippedDuplicates: [],
  diagnostics: [],
  loadReason: 'session_start',
}

/** The one legacy-input mapping: 'auto'
 *  is accepted for persisted-settings compatibility and resolves to the
 *  native contract; the resolution records the mapping. */
function resolveEffectiveProfile(
  requested: InstructionProfile,
  requestedOrigin: InstructionProfileResolution['requestedOrigin'],
): InstructionProfileResolution {
  if (requested === 'auto') {
    return {
      requested,
      requestedOrigin,
      resolved: 'native',
      mapped: 'auto-to-native',
    }
  }
  return { requested, requestedOrigin, resolved: requested }
}

export function getInstructionCompositionState(): InstructionCompositionState {
  return lastComposition
}

/** The conventions the CURRENT resolution composes, low→high priority. */
function activeConventions(): InstructionConvention[] {
  const { profile: requested, origin } = resolveRequestedInstructionProfile()
  const { resolved } = resolveEffectiveProfile(requested, origin)
  return adapterForProfile().conventionsFor(resolved)
}

/**
 * One discovery pass over an ordered convention list (managed → user → one
 * chain per instruction root: the boot cwd, then each operator-added
 * directory → memdir entrypoint).
 *
 * Identical-content dedup: an entry whose exact content already composed is
 * dropped and recorded — aliases and copies never append twice.
 */
async function walkConventions(
  conventions: InstructionConvention[],
  forceIncludeExternal: boolean,
  skippedDuplicates: { path: string; family: InstructionFamily }[],
  diagnostics?: InstructionDiagnostic[],
): Promise<InstructionSourceEntry[]> {
  const result: InstructionSourceEntry[] = []
  const processedPaths = new Set<string>()
  const composedDigests = new Set<string>()
  const config = getCurrentProjectConfig()
  const includeExternal =
    forceIncludeExternal ||
    config.hasClaudeMdExternalIncludesApproved ||
    false

  /** Tag a stage's entries with provenance (and, for a root chain, the
   *  root they came from) and apply the native-family identical-content
   *  dedup. */
  const push = (
    files: InstructionSourceEntry[],
    family: InstructionFamily,
    origin: InstructionOrigin,
    root?: string,
  ): void => {
    for (const f of files) {
      f.family = family
      f.origin = origin
      if (root !== undefined) f.root = root
      const digest = sha256(f.content)
      if (composedDigests.has(digest)) {
        skippedDuplicates.push({ path: f.path, family })
        diagnostics?.push({
          kind: 'duplicate-content',
          path: f.path,
          detail: 'identical bytes already composed; this copy was dropped',
        })
        continue
      }
      composedDigests.add(digest)
      result.push(f)
    }
  }

  // Managed stage first — policy content composes unconditionally (no
  // setting-source gate can turn the managed layer off).
  for (const convention of conventions) {
    const managedFile = convention.managedFile()
    if (managedFile) {
      push(
        await processInstructionFile(
          convention,
          managedFile,
          'Managed',
          processedPaths,
          includeExternal,
          0,
          undefined,
          diagnostics,
        ),
        convention.family,
        'managed',
      )
    }
    // The managed rules directory rides the same stage.
    const managedRulesDir = convention.managedRulesDir()
    if (managedRulesDir) {
      push(
        await processRulesDir({
          convention,
          rulesDir: managedRulesDir,
          type: 'Managed',
          processedPaths,
          includeExternal,
          conditionalRule: false,
        }),
        convention.family,
        'managed-rules',
      )
    }
  }

  // User stage — gated on the userSettings source. The user's own files may
  // always @include outside the project (they wrote them; the external-
  // approval gate protects against PROJECT files reaching outward).
  if (isSettingSourceEnabled('userSettings')) {
    for (const convention of conventions) {
      const userFile = convention.userFile()
      if (userFile) {
        push(
          await processInstructionFile(
            convention,
            userFile,
            'User',
            processedPaths,
            true, // user files: external includes always allowed
            0,
            undefined,
            diagnostics,
          ),
          convention.family,
          'user',
        )
      }
      const userRulesDir = convention.userRulesDir()
      if (userRulesDir) {
        push(
          await processRulesDir({
            convention,
            rulesDir: userRulesDir,
            type: 'User',
            processedPaths,
            includeExternal: true,
            conditionalRule: false,
          }),
          convention.family,
          'user-rules',
        )
      }
    }
  }

  /**
   * One instruction root's chain. The boot cwd walks its ancestors
   * (filesystem root → the cwd itself) outer→inner so outer instructions
   * compose before inner ones override, with the nested-worktree
   * double-load guard computed for that chain. An operator-added root
   * contributes ITSELF only — its MERCURY.md, its project-home MERCURY.md,
   * its rules dir, its MERCURY.local.md — never the directories above it:
   * the operator named the root. Every entry is stamped with the root it
   * came from.
   *
   * Nested-worktree guard: a worktree carved INSIDE its main repo (`mercury
   * -w` puts them under .mercury/worktrees/<name>/) makes the upward walk
   * cross TWO roots — the worktree's and the main repo's — and each root
   * carries its own checkout of the same checked-in files (MERCURY.md,
   * .mercury/rules/*.md). Project-type files from directories above the
   * worktree yet inside the canonical repo are skipped — the worktree's own
   * checkout already supplied them. The gitignored MERCURY.local.md lives
   * only in the main checkout and still composes.
   */
  const walkRootChain = async (
    root: string,
    origin: InstructionOrigin,
    ancestry: boolean,
  ): Promise<void> => {
    const chainRoot = resolve(root)
    const dirs: string[] = []
    if (ancestry) {
      let currentDir = chainRoot
      while (currentDir !== parse(currentDir).root) {
        dirs.push(currentDir)
        currentDir = dirname(currentDir)
      }
    } else {
      dirs.push(chainRoot)
    }

    const gitRoot = ancestry ? findGitRoot(chainRoot) : null
    const canonicalRoot = ancestry ? findCanonicalGitRoot(chainRoot) : null
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !==
        normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    for (const dir of dirs.reverse()) {
      // Nested worktree: dirs inside the canonical repo but outside the
      // worktree hold the main checkout's copies — skip their checked-in
      // files (see isNestedWorktree above).
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      for (const convention of conventions) {
        // Checked-in project files + rules ride the projectSettings source.
        if (isSettingSourceEnabled('projectSettings') && !skipProject) {
          for (const projectPath of convention.projectDirFiles(dir)) {
            push(
              await processInstructionFile(
                convention,
                projectPath,
                'Project',
                processedPaths,
                includeExternal,
                0,
                undefined,
                diagnostics,
              ),
              convention.family,
              origin,
              chainRoot,
            )
          }

          for (const rulesDir of convention.projectRulesDirs(dir)) {
            push(
              await processRulesDir({
                convention,
                rulesDir,
                type: 'Project',
                processedPaths,
                includeExternal,
                conditionalRule: false,
              }),
              convention.family,
              origin,
              chainRoot,
            )
          }
        }

        // The gitignored local file rides the localSettings source (it
        // exists only in the main checkout, so the nested-worktree skip
        // never applies).
        if (isSettingSourceEnabled('localSettings')) {
          const localPaths =
            convention.localDirFiles?.(dir) ??
            (convention.localDirFile(dir) !== null ? [convention.localDirFile(dir) as string] : [])
          for (const localPath of localPaths) {
            push(
              await processInstructionFile(
                convention,
                localPath,
                'Local',
                processedPaths,
                includeExternal,
                0,
                undefined,
                diagnostics,
              ),
              convention.family,
              origin,
              chainRoot,
            )
          }
        }
      }
    }
  }

  // Project/Local stage — ONE chain per instruction root. The boot cwd is
  // the first root and walks its ancestry; every directory the operator
  // added (--add-dir at boot, the session's workspace — getAddedDirectories(),
  // kept by syncInstructionRootsWithWorkspace below) is one more root,
  // contributing itself, stamped with the root it came from under origin
  // 'additional-dir'. Path identity dedups a directory two roots share (it
  // composes once, under the first chain that reached it); identical bytes
  // dedup after that.
  await walkRootChain(getOriginalCwd(), 'project-walk', true)
  for (const added of getAddedDirectories()) {
    await walkRootChain(added, 'additional-dir', false)
  }

  // Memdir entrypoint: the auto-memory index file, when the feature is on.
  // Composed OUTSIDE the convention push — it is not an instruction file
  // and never dedups against them; only path identity guards a double add.
  if (isAutoMemoryEnabled()) {
    const { info: memdirEntry } = await safelyReadInstructionFileAsync(
      getAutoMemEntrypoint(),
      'AutoMem',
    )
    if (memdirEntry) {
      const normalizedPath = normalizePathForComparison(memdirEntry.path)
      if (!processedPaths.has(normalizedPath)) {
        processedPaths.add(normalizedPath)
        memdirEntry.family = 'native'
        memdirEntry.origin = 'automem'
        result.push(memdirEntry)
      }
    }
  }

  return result
}

export const getInstructionFiles = memoize(
  async (
    forceIncludeExternal: boolean = false,
  ): Promise<InstructionSourceEntry[]> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'memory_files_started')

    const { profile: requested, origin: requestedOrigin } =
      resolveRequestedInstructionProfile()
    const adapter = adapterForProfile()
    const resolution = resolveEffectiveProfile(requested, requestedOrigin)
    const skippedDuplicates: { path: string; family: InstructionFamily }[] = []
    const diagnostics: InstructionDiagnostic[] = []

    const result = await walkConventions(
      adapter.conventionsFor(resolution.resolved),
      forceIncludeExternal,
      skippedDuplicates,
      diagnostics,
    )

    // Consume the one-shot load reason HERE (once per non-force cache miss —
    // the same cadence as before; the hook block below reuses the value).
    const eagerLoadReason = forceIncludeExternal
      ? undefined
      : consumeNextEagerLoadReason()

    lastComposition = {
      resolution,
      adapterId: adapter.id,
      skippedDuplicates,
      diagnostics,
      loadReason:
        eagerLoadReason ??
        (forceIncludeExternal ? 'external-check' : 'cache-refresh'),
    }

    const totalContentLength = result.reduce(
      (sum, f) => sum + f.content.length,
      0,
    )

    logForDiagnosticsNoPII('info', 'memory_files_completed', {
      duration_ms: Date.now() - startTime,
      file_count: result.length,
      total_content_length: totalContentLength,
    })

    // InstructionsLoaded hooks — fire-and-forget observability, one call
    // per composed file. Three deliberate exclusions:
    //  · AutoMem/TeamMem entries: a separate memory system, not
    //    "instructions" in the instruction-file/rules sense;
    //  · the forceIncludeExternal=true pass: that variant only feeds
    //    getExternalInstructionIncludes()' approval check, never context —
    //    firing there would double-fire every startup;
    //  · a consumed one-shot: the flag was released above on EVERY eager
    //    cache miss (not just when a hook exists), so a hook registered
    //    mid-session can't inherit a stale 'session_start' reason from a
    //    later bare cache clear.
    if (!forceIncludeExternal) {
      if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
        for (const file of result) {
          if (!isInstructionsMemoryType(file.type)) continue
          const loadReason = file.parent ? 'include' : eagerLoadReason
          void executeInstructionsLoadedHooks(
            file.path,
            file.type,
            loadReason,
            {
              globs: file.globs,
              parentFilePath: file.parent,
            },
          )
        }
      }
    }

    return result
  },
)

function isInstructionsMemoryType(
  type: MemoryType,
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

// The WHY behind the next eager composition, reported to the
// InstructionsLoaded hook for top-level (non-included) files.
// resetInstructionFilesCache stamps it ('compact' when compaction reloads)
// so the hook never misreports a reload as 'session_start'. One-shot: reads
// reset it to 'session_start'.
let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

// Whether the next cache miss is hook-worthy. Starts true (the session_start
// load), consumed on firing, re-armed ONLY by resetInstructionFilesCache().
// Pure-correctness invalidation (worktree enter/exit, settings sync, the
// /memory dialog) goes through clearInstructionFileCaches() and never
// re-arms — those reloads are not "instructions loaded" events.
let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

// Invalidation listeners — observers (the effective-size measure behind the
// trim chip) that must re-read after ANY discovery-cache clear. Fire-and-
// forget notification, never a lifecycle owner; a throwing listener is
// swallowed so cache correctness can never hinge on an observer.
const cacheInvalidationListeners = new Set<() => void>()

export function onInstructionCacheInvalidated(listener: () => void): () => void {
  cacheInvalidationListeners.add(listener)
  return () => {
    cacheInvalidationListeners.delete(listener)
  }
}

/**
 * Invalidate the discovery cache WITHOUT arming the InstructionsLoaded hook
 * — the correctness-only variant (worktree enter/exit, settings sync, the
 * /memory dialog). When the reload genuinely represents instructions
 * re-entering context (compaction), use resetInstructionFilesCache().
 */
export function clearInstructionFileCaches(): void {
  // Optional-chained because tests spyOn getInstructionFiles, and the spy
  // replaces the memoize wrapper (no .cache on the replacement).
  getInstructionFiles.cache?.clear?.()
  // The exclusion matcher's realpath memo shares the discovery cache's
  // lifetime: a retargeted symlink resolves afresh on the next walk.
  clearExcludeResolutionMemo()
  for (const listener of cacheInvalidationListeners) {
    try {
      listener()
    } catch {
      // observer-only — see the set's doc block
    }
  }
}

export function resetInstructionFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearInstructionFileCaches()
}

// ── The instruction roots ────────────────────────────────────────────────────
//
// An instruction root is a directory whose chain the walk composes: the boot
// cwd, plus every directory the operator added — `--add-dir` at boot (main.tsx
// seeds the bootstrap list) and the session's workspace (the tool-permission
// context's additionalWorkingDirectories). The engine is the ONE owner of the
// widen/narrow act: every path that changes the workspace — the /add-dir
// command, the /permissions workspace tab, an accepted "add this directory"
// permission suggestion, a teammate or SDK update, the removal dialog — lands
// in the state-change choke point (state/onChangeAppState.ts), which calls
// syncInstructionRootsWithWorkspace once per change. Nothing else writes the
// list in-session.

/** Every instruction root: the boot cwd, then the operator's added
 *  directories in the order they were added. */
export function instructionRoots(): string[] {
  return [getOriginalCwd(), ...getAddedDirectories()]
}

/** Whether `dir` is `root` or lives under it — a pure path comparison,
 *  normalized like the dedup keys; no filesystem. */
function dirInsideRoot(dir: string, root: string): boolean {
  const d = normalizePathForComparison(dir)
  const r = normalizePathForComparison(root)
  return d === r || d.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * The instruction root a directory belongs to: the boot cwd when the
 * directory lies inside it, else the deepest added root containing it, else
 * the cwd (a path outside every root anchors at the cwd and climbs nothing).
 * The nested-guide ladders (utils/attachments/nestedMemory.ts) anchor here.
 */
export function instructionRootForPath(
  dir: string,
  originalCwd: string = getOriginalCwd(),
  addedRoots: readonly string[] = getAddedDirectories(),
): string {
  if (dirInsideRoot(dir, originalCwd)) return originalCwd
  let deepest: string | undefined
  for (const added of addedRoots) {
    const root = resolve(added)
    if (dirInsideRoot(dir, root) && (deepest === undefined || root.length > deepest.length)) {
      deepest = root
    }
  }
  return deepest ?? originalCwd
}

/** The workspace directories mirrored so far — the diff base for the next
 *  change, so a workspace map mutated in place still reports its additions
 *  and removals. */
let mirroredWorkspace = new Set<string>()

/**
 * Mirror the workspace's admitted directories into the added-directories
 * list: a directory that joined the workspace becomes an instruction root, one
 * that left it stops being one. Directories the boot flag pass seeded
 * (`--add-dir`) are never in the workspace map and are therefore never removed
 * here. A changed root set changes which instruction files apply, so the act
 * is one: the list moves, the cached instruction prompt (the auto-mode
 * classifier's copy) is dropped rather than left stale, and the discovery
 * cache resets — the next composition sees the new roots. Returns true when
 * the root set changed; the caller drops the composed user context.
 */
export function syncInstructionRootsWithWorkspace(
  workspace: ReadonlyMap<string, unknown>,
): boolean {
  const current = new Set(workspace.keys())
  const joined = [...current].filter(dir => !mirroredWorkspace.has(dir))
  const left = [...mirroredWorkspace].filter(dir => !current.has(dir))
  mirroredWorkspace = current
  if (joined.length === 0 && left.length === 0) return false

  const list = getAddedDirectories()
  const next = [
    ...list.filter(dir => !left.includes(dir)),
    ...joined.filter(dir => !list.includes(dir)),
  ]
  if (next.length === list.length && next.every((dir, i) => dir === list[i])) {
    return false
  }
  setAddedDirectories(next)
  setCachedInstructionPrompt(null)
  resetInstructionFilesCache()
  return true
}

export function getLargeMemoryFiles(
  files: InstructionSourceEntry[],
): InstructionSourceEntry[] {
  const cap = getMaxMemoryCharacterCount()
  return files.filter(f => f.content.length > cap)
}

/**
 * When relevant-memory-recall mode is on, the findRelevantMemories prefetch
 * surfaces memory files via attachments, so the MEMORY.md index is not
 * injected into the system prompt. Callsites that care about "what's actually
 * in context" (context builder, /context viz) should filter through this.
 *
 * The mode is enabled by the `mercury_moth_copse` feature gate OR, on
 * Mercury, the explicit DEFAULT-OFF opt-in `MERCURY_RELEVANT_RECALL=1`
 * (relevantMemoryRecallEnabled). OFF ⇒ the list is returned unchanged
 * (byte-identical). The actual filtering logic lives in paths.ts so it is
 * unit-drivable without the full engine import graph.
 */
export function filterInjectedInstructionFiles(
  files: InstructionSourceEntry[],
): InstructionSourceEntry[] {
  return filterInjectedMemoryFilesByRecall(
    files,
    relevantMemoryRecallEnabled(),
  )
}

/**
 * Render the composed entries into the ONE instruction block the system
 * prompt carries: the binding header, then each file's contents under a
 * per-type provenance label. Every output string here is wire bytes under
 * the byte contract (see the module header) — the shape of this block is
 * what the model was trained against.
 */
export const composeInstructionPrompt = (
  memoryFiles: InstructionSourceEntry[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []
  const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
    'mercury_paper_halyard',
    false,
  )

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (skipProjectLevel && (file.type === 'Project' || file.type === 'Local'))
      continue
    if (file.content) {
      const content = file.content.trim()
      memories.push(
        `Contents of ${file.path}${describeInstructionSource(file)}:\n\n${content}`,
      )
    }
  }

  if (memories.length === 0) {
    return ''
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

/**
 * The provenance label after a composed file's path. The four main-root
 * labels are wire bytes under the byte contract; a slice from an
 * operator-added root names the root it came from — Mercury's voice, so the
 * model can tell the roots apart.
 */
function describeInstructionSource(file: InstructionSourceEntry): string {
  if (file.origin === 'additional-dir' && file.root) {
    return file.type === 'Local'
      ? ` (user's private project instructions for the added directory ${file.root}, not checked in)`
      : ` (project instructions for the added directory ${file.root}, checked into that codebase)`
  }
  return file.type === 'Project'
    ? ' (project instructions, checked into the codebase)'
    : file.type === 'Local'
      ? " (user's private project instructions, not checked in)"
      : file.type === 'AutoMem'
        ? " (user's auto-memory, persists across conversations)"
        : " (user's private global instructions for all projects)"
}

/**
 * Phase one of per-read rule loading: the managed and user conditional rules
 * whose frontmatter globs match `targetPath`. `processedPaths` is shared
 * with the later phases and mutated — a rule composed here never composes
 * again downstream.
 */
export async function getManagedAndUserConditionalInstructionRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<InstructionSourceEntry[]> {
  const result: InstructionSourceEntry[] = []

  for (const convention of activeConventions()) {
    const managedRulesDir = convention.managedRulesDir()
    if (managedRulesDir) {
      result.push(
        ...(await processConditionedRules(
          convention,
          targetPath,
          managedRulesDir,
          'Managed',
          processedPaths,
          false,
        )),
      )
    }

    if (isSettingSourceEnabled('userSettings')) {
      const userRulesDir = convention.userRulesDir()
      if (userRulesDir) {
        result.push(
          ...(await processConditionedRules(
            convention,
            targetPath,
            userRulesDir,
            'User',
            processedPaths,
            true,
          )),
        )
      }
    }
  }

  return result
}

/**
 * One nested directory's contribution (a dir between the file's instruction
 * root — the boot cwd, or the operator-added directory that contains the
 * file — and the file being touched): its per-directory instruction files,
 * its unconditional rules, and its conditional rules matched against
 * `targetPath`. The boot walk never descends below a root, so these load
 * lazily at first touch.
 */
export async function getInstructionFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
): Promise<InstructionSourceEntry[]> {
  const result: InstructionSourceEntry[] = []
  const conventions = activeConventions()
  // THE SAME APPROVAL AS THE BOOT WALK (FN-017 rank 13): the lazy nested
  // loader passed a literal `false` for external includes and no
  // diagnostics, so a nested file's approved external import could never
  // compose (the boot walk ascends from the cwd and never descends — this
  // road is the ONLY one for directories below it) and the
  // external-import-blocked finding never reached the bundle or /health.
  // One owner of the decision: the project's recorded approval.
  const includeExternal = getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved ?? false

  for (const convention of conventions) {
    if (isSettingSourceEnabled('projectSettings')) {
      for (const projectPath of convention.projectDirFiles(dir)) {
        result.push(
          ...(await processInstructionFile(
            convention,
            projectPath,
            'Project',
            processedPaths,
            includeExternal,
            0,
            undefined,
            diagnostics,
          )),
        )
      }
    }

    if (isSettingSourceEnabled('localSettings')) {
      const localPaths =
        convention.localDirFiles?.(dir) ??
        (convention.localDirFile(dir) !== null ? [convention.localDirFile(dir) as string] : [])
      for (const localPath of localPaths) {
        result.push(
          ...(await processInstructionFile(
            convention,
            localPath,
            'Local',
            processedPaths,
            includeExternal,
            0,
            undefined,
            diagnostics,
          )),
        )
      }
    }

    // The rules dir holds BOTH kinds and each pass filters to its own —
    // so the unconditional pass runs on a FORKED path set: letting it mark
    // paths in the shared set would make the conditional pass right after
    // see every rule as "already processed" and compose nothing.
    const unconditionalProcessedPaths = new Set(processedPaths)
    for (const rulesDir of convention.projectRulesDirs(dir)) {
      result.push(
        ...(await processRulesDir({
          convention,
          rulesDir,
          type: 'Project',
          processedPaths: unconditionalProcessedPaths,
          includeExternal: false,
          conditionalRule: false,
        })),
      )

      result.push(
        ...(await processConditionedRules(
          convention,
          targetPath,
          rulesDir,
          'Project',
          processedPaths,
          false,
        )),
      )
    }

    // Fold the fork back: later directories must see the unconditional
    // rules this one already composed.
    for (const path of unconditionalProcessedPaths) {
      processedPaths.add(path)
    }
  }

  return result
}

/**
 * A root-level directory's (filesystem root → the file's instruction root)
 * CONDITIONAL rules for `targetPath`. Only the conditional kind — the boot
 * walk already composed these directories' unconditional rules eagerly.
 */
export async function getConditionalInstructionRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<InstructionSourceEntry[]> {
  const results: InstructionSourceEntry[] = []
  // Identical-content dedup ACROSS HOMES: the boot walk's
  // native dedup law extended to the per-read conditional path — a rule whose
  // exact bytes already composed for this read (e.g. the same rule bytes
  // reachable through two project-config homes) is dropped, never injected
  // twice.
  const composedDigests = new Set<string>()
  for (const convention of activeConventions()) {
    for (const rulesDir of convention.projectRulesDirs(dir)) {
      const batch = await processConditionedRules(
        convention,
        targetPath,
        rulesDir,
        'Project',
        processedPaths,
        false,
      )
      for (const entry of batch) {
        const digest = sha256(entry.content)
        if (composedDigests.has(digest)) continue
        composedDigests.add(digest)
        results.push(entry)
      }
    }
  }
  return results
}

export type ExternalInstructionInclude = {
  path: string
  parent: string
}

export function getExternalInstructionIncludes(
  files: InstructionSourceEntry[],
): ExternalInstructionInclude[] {
  const externals: ExternalInstructionInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInInstructionRoots(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalInstructionIncludes(
  files: InstructionSourceEntry[],
): boolean {
  return getExternalInstructionIncludes(files).length > 0
}

/**
 * One-shot approval gate for the external-includes dialog: never re-ask once
 * the project has answered (approved or declined — both persist in project
 * config), and only ask when the discovered instruction files actually
 * @include content outside the working directory.
 */
export async function shouldShowExternalInstructionIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (
    config.hasClaudeMdExternalIncludesApproved ||
    config.hasClaudeMdExternalIncludesWarningShown
  ) {
    return false
  }

  return hasExternalInstructionIncludes(await getInstructionFiles(true))
}

/**
 * Check if a file path is an instruction file under the given conventions
 * (per-directory instruction files anywhere, or .md files under a rules
 * path marker).
 */
export function isInstructionFilePath(
  filePath: string,
  conventions: InstructionConvention[] = activeConventions(),
): boolean {
  const name = basename(filePath)

  for (const convention of conventions) {
    if (convention.instructionFileNames.includes(name)) {
      return true
    }
    if (
      name.endsWith('.md') &&
      convention.rulesPathMarkers.some(marker => filePath.includes(marker))
    ) {
      return true
    }
  }

  return false
}

/**
 * item 8 — share file knowledge: the model verbatim-holds every
 * INJECTED instruction file (composeInstructionPrompt prints full contents,
 * incl. the auto-memory MEMORY.md), so the Write/Edit read-before-write gate
 * should honor that knowledge — refusing a FIRST Write to MEMORY.md
 * "File has not
 * been read yet" for content the system prompt already carries burns a
 * round trip.
 *
 * Seeds a session's FileStateCache from the SAME memoized discovery pass the
 * prompt composer reads (one source, no drift), honestly:
 *  · only files actually injected (relevant-recall filtering respected);
 *  · only when the CURRENT disk bytes still equal the known content
 *    (rawContent when injection transformed it) — a file changed since
 *    discovery is NOT known, and the gate's protection stands;
 *  · never overwrites an existing entry (a real Read outranks the seed).
 * Best-effort: any surprise skips that file; seeding never blocks boot.
 */
export async function seedFileKnowledgeFromInjectedInstructions(
  readFileState: FileStateCache,
): Promise<void> {
  try {
    const { readFileSync, statSync } = await import('node:fs')
    const files = filterInjectedInstructionFiles(await getInstructionFiles())
    for (const f of files) {
      try {
        if (!f.path || !f.content) continue
        if (readFileState.has(f.path)) continue
        const known = f.contentDiffersFromDisk ? (f.rawContent ?? null) : f.content
        if (known === null) continue
        const disk = readFileSync(f.path, 'utf8')
        if (disk !== known) continue // changed since discovery — not known
        readFileState.set(f.path, {
          content: disk,
          timestamp: Math.floor(statSync(f.path).mtimeMs),
          offset: undefined,
          limit: undefined,
        })
      } catch {
        // this file stays unseeded — the gate's protection stands for it
      }
    }
  } catch {
    // seeding is an affordance, never a boot blocker
  }
}

// ── The typed instruction bundle ─────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Build the typed bundle view over an ordered entry list. Deterministic:
 *  unchanged files ⇒ unchanged digests ⇒ unchanged bundleDigest. Bodies stay
 *  with the engine — the bundle carries refs, digests and lengths only. */
export function buildInstructionBundle(
  files: InstructionSourceEntry[],
  resolution: InstructionProfileResolution,
  adapterId: string,
  skippedDuplicates: { path: string; family: InstructionFamily }[] = [],
  diagnostics: InstructionDiagnostic[] = [],
): InstructionBundle {
  const entries: InstructionBundleEntry[] = files.map(f => ({
    path: f.path,
    type: f.type,
    family: f.family ?? 'native',
    origin: f.origin ?? 'project-walk',
    contentDigest: sha256(f.content),
    contentLength: f.content.length,
    ...(f.parent !== undefined && { parent: f.parent }),
    ...(f.globs !== undefined && { globs: f.globs }),
    ...(f.root !== undefined && { root: f.root }),
  }))
  const bundleDigest = sha256(
    entries.map(e => `${e.path}\n${e.contentDigest}`).join('\n'),
  )
  return {
    resolution,
    adapterId,
    entries,
    bundleDigest,
    composedCount: entries.filter(e => e.contentLength > 0).length,
    skippedDuplicates,
    diagnostics,
  }
}

/** The typed bundle for the CURRENT session resolution — entries, digests
 *  and the inspectable resolution, exactly as the last composition ran. */
export async function getInstructionBundle(): Promise<InstructionBundle> {
  const files = await getInstructionFiles()
  const { resolution, adapterId, skippedDuplicates, diagnostics } =
    lastComposition
  return buildInstructionBundle(
    files,
    resolution,
    adapterId,
    skippedDuplicates,
    diagnostics,
  )
}

/**
 * A per-spawn instruction slice for an EXPLICIT profile (agent/role
 * selection) — composed independently of the session's memoized composition
 * so two concurrently running agents with different profiles each receive
 * only their own ordered bundle. Uncached by design: one walk per spawn,
 * captured frozen; the session cache and lifecycle stay untouched.
 */
export async function getInstructionSliceForProfile(
  profile: InstructionProfile,
): Promise<{ instructionPrompt: string | null; bundle: InstructionBundle }> {
  const adapter = adapterForProfile()
  const resolution = resolveEffectiveProfile(profile, 'agent')
  const skippedDuplicates: { path: string; family: InstructionFamily }[] = []
  const diagnostics: InstructionDiagnostic[] = []
  const files = await walkConventions(
    adapter.conventionsFor(resolution.resolved),
    false,
    skippedDuplicates,
    diagnostics,
  )
  const composed = composeInstructionPrompt(
    filterInjectedInstructionFiles(files),
  )
  return {
    instructionPrompt: composed || null,
    bundle: buildInstructionBundle(
      files,
      resolution,
      adapter.id,
      skippedDuplicates,
      diagnostics,
    ),
  }
}
