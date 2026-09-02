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

export const MIN_MEMORY_CHARACTER_COUNT = 40000

export const MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO = 0.05

const CHARS_PER_TOKEN_ESTIMATE = 4

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

export const MAX_MEMORY_CHARACTER_COUNT = MIN_MEMORY_CHARACTER_COUNT

type InstructionCompositionState = {
  resolution: InstructionProfileResolution
  adapterId: string
  skippedDuplicates: { path: string; family: InstructionFamily }[]
  diagnostics: InstructionDiagnostic[]
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

function activeConventions(): InstructionConvention[] {
  const { profile: requested, origin } = resolveRequestedInstructionProfile()
  const { resolved } = resolveEffectiveProfile(requested, origin)
  return adapterForProfile().conventionsFor(resolved)
}

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
            true,
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
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      for (const convention of conventions) {
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

  await walkRootChain(getOriginalCwd(), 'project-walk', true)
  for (const added of getAddedDirectories()) {
    await walkRootChain(added, 'additional-dir', false)
  }

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

let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

const cacheInvalidationListeners = new Set<() => void>()

export function onInstructionCacheInvalidated(listener: () => void): () => void {
  cacheInvalidationListeners.add(listener)
  return () => {
    cacheInvalidationListeners.delete(listener)
  }
}

export function clearInstructionFileCaches(): void {
  getInstructionFiles.cache?.clear?.()
  clearExcludeResolutionMemo()
  for (const listener of cacheInvalidationListeners) {
    try {
      listener()
    } catch {
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


export function instructionRoots(): string[] {
  return [getOriginalCwd(), ...getAddedDirectories()]
}

function dirInsideRoot(dir: string, root: string): boolean {
  const d = normalizePathForComparison(dir)
  const r = normalizePathForComparison(root)
  return d === r || d.startsWith(r.endsWith('/') ? r : `${r}/`)
}

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

let mirroredWorkspace = new Set<string>()

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

export function filterInjectedInstructionFiles(
  files: InstructionSourceEntry[],
): InstructionSourceEntry[] {
  return filterInjectedMemoryFilesByRecall(
    files,
    relevantMemoryRecallEnabled(),
  )
}

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

export async function getInstructionFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
): Promise<InstructionSourceEntry[]> {
  const result: InstructionSourceEntry[] = []
  const conventions = activeConventions()
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

    for (const path of unconditionalProcessedPaths) {
      processedPaths.add(path)
    }
  }

  return result
}

export async function getConditionalInstructionRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<InstructionSourceEntry[]> {
  const results: InstructionSourceEntry[] = []
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
        if (disk !== known) continue
        readFileState.set(f.path, {
          content: disk,
          timestamp: Math.floor(statSync(f.path).mtimeMs),
          offset: undefined,
          limit: undefined,
        })
      } catch {
      }
    }
  } catch {
  }
}


function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

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
