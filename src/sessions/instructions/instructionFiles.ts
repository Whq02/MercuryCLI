import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, parse, resolve } from 'path'

import {
  getOriginalCwd,
  getSdkBetas,
} from '../../boot/process-state/processState.js'
import { getCurrentProjectConfig } from '../../platform/settings/config.js'
import { untrustedWorkspaceHeadless } from '../../platform/config/trust.js'
import {
  getContextWindowForModel,
  MODEL_CONTEXT_WINDOW_DEFAULT,
} from '../../engine/compaction-window/contextFill.js'
import { logForDiagnosticsNoPII } from '../../platform/logs/diagnosticsLog.js'
import { normalizePathForComparison } from '../../platform/files/file.js'
import { detectEncodingForResolvedPath } from '../../platform/files/syncFileRead.js'
import type { FileStateCache } from '../../platform/files/fileStateCache.js'
import { getFsImplementation, safeResolvePath } from '../../platform/files/fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from '../../platform/git/git.js'
import { stripBOM } from '../../platform/storage/jsonRead.js'
import type { InstructionFileType } from '../memory-shapes/types.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { pathInWorkingPath } from '../../permissions/rules/filesystem.js'
import { isSettingSourceEnabled } from '../../platform/settings/settingSources.js'
import { forgetHiddenCharacters } from '../../platform/text/hiddenCharacterFindings.js'
import { adapterForProfile, folderSources, hasPrimaryProjectFile } from './adapters/index.js'
import { offeredRulesText } from './attachedText.js'
import { conventionsForProfile } from './compositionOrder.js'
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
} from '../instruction-contracts/contracts.js'
import {
  clearExcludeResolutionMemo,
  type ExternalImports,
  importedRuleGoverns,
  pathInInstructionRoots,
  processConditionedRules,
  processInstructionFile,
  processRulesDir,
} from './discovery.js'
import { resolveRequestedInstructionProfile } from './profile.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const MIN_INSTRUCTION_FILE_CHARACTER_COUNT = 40000

export const MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO = 0.05

const CHARS_PER_TOKEN_ESTIMATE = 4

export function getMaxInstructionFileCharacterCount(
  model: string = getEngineModel(),
): number {
  const limit = getContextWindowForModel(model, getSdkBetas())
  const contextTokens =
    Number.isFinite(limit) && limit > 0 ? limit : MODEL_CONTEXT_WINDOW_DEFAULT
  return Math.max(
    MIN_INSTRUCTION_FILE_CHARACTER_COUNT,
    Math.round(
      contextTokens * MAX_INSTRUCTION_FILE_TOKEN_CONTEXT_RATIO * CHARS_PER_TOKEN_ESTIMATE,
    ),
  )
}

export const MAX_INSTRUCTION_FILE_CHARACTER_COUNT = MIN_INSTRUCTION_FILE_CHARACTER_COUNT

type InstructionCompositionState = {
  resolution: InstructionProfileResolution
  adapterId: string
  fallbackComposed: boolean
  nearestHolders: Record<string, string>
  importedScoped: InstructionSourceEntry[]
  namedRules: NamedRules[]
  skippedDuplicates: { path: string; family: InstructionFamily }[]
  diagnostics: InstructionDiagnostic[]
  loadReason: string
}

type NamedRules = { convention: InstructionConvention; rulesDir: string; by: string; guides: string[] }

let lastComposition: InstructionCompositionState = {
  resolution: {
    requested: 'auto',
    requestedOrigin: 'default',
    resolved: 'auto',
  },
  adapterId: 'mercury',
  fallbackComposed: false,
  nearestHolders: {},
  importedScoped: [],
  namedRules: [],
  skippedDuplicates: [],
  diagnostics: [],
  loadReason: 'session_start',
}

function resolveEffectiveProfile(
  requested: InstructionProfile,
  requestedOrigin: InstructionProfileResolution['requestedOrigin'],
): InstructionProfileResolution {
  return { requested, requestedOrigin, resolved: requested }
}

export function getInstructionCompositionState(): InstructionCompositionState {
  return lastComposition
}

function activeConventions(): InstructionConvention[] {
  const { profile: requested, origin } = resolveRequestedInstructionProfile()
  const { resolved } = resolveEffectiveProfile(requested, origin)
  return conventionsForProfile(resolved)
}

export { conventionsForProfile } from './compositionOrder.js'

async function walkConventions(
  conventions: InstructionConvention[],
  forceIncludeExternal: boolean,
  skippedDuplicates: { path: string; family: InstructionFamily }[],
  diagnostics?: InstructionDiagnostic[],
): Promise<{
  entries: InstructionSourceEntry[]
  fallbackComposed: boolean
  nearestHolders: Record<string, string>
  importedScoped: InstructionSourceEntry[]
  namedRules: NamedRules[]
  heldShares: ExternalInstructionInclude[]
}> {
  const result: InstructionSourceEntry[] = []
  let fallbackComposed = false
  const nearestHolders: Record<string, string> = {}
  const importedScoped: InstructionSourceEntry[] = []
  const namedRules: NamedRules[] = []
  const processedPaths = new Set<string>()
  const composedDigests = new Set<string>()
  const config = getCurrentProjectConfig()
  const heldShares: ExternalInstructionInclude[] = []
  const includeExternal: ExternalImports = config.hasExternalIncludesApproved ? true : forceIncludeExternal ? { heldShares } : false

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
      if (f.anchor !== undefined) {
        importedScoped.push(f)
        continue
      }
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

  const composeNamed = async (set: InstructionConvention[], chain: string[]): Promise<void> => {
    if (!isSettingSourceEnabled('userSettings')) return
    for (const convention of set) {
      const named = convention.named?.() ?? null
      if (named === null) continue
      const onChain = new Set(chain.map(normalizePathForComparison))
      const seenFolders = new Set<string>()
      const marked = (entries: InstructionSourceEntry[]): InstructionSourceEntry[] => {
        for (const entry of entries) entry.namedBy = named.by
        return entries
      }
      for (const { folder, guides, rules } of named.folders) {
        const identity = normalizePathForComparison(safeResolvePath(getFsImplementation(), folder).resolvedPath)
        if (onChain.has(identity) || seenFolders.has(identity)) continue
        seenFolders.add(identity)
        for (const guide of guides) {
          push(marked(await processInstructionFile(convention, guide, 'User', processedPaths, true, 0, undefined, diagnostics)), convention.family, 'user')
        }
        for (const rulesDir of rules) {
          namedRules.push({ convention, rulesDir, by: named.by, guides })
          push(
            marked(await processRulesDir({ convention, rulesDir, type: 'User', processedPaths, includeExternal: true, conditionalRule: false, diagnostics })),
            convention.family,
            'user-rules',
          )
        }
      }
    }
  }

  const walkRootChain = async (
    root: string,
    origin: InstructionOrigin,
    ancestry: boolean,
  ): Promise<void> => {
    if (untrustedWorkspaceHeadless()) {
      await composeNamed(conventions.filter(c => c.fallback), [])
      return
    }
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

    const own = folderSources(chainRoot)
    const primary = conventions.filter(c => !c.fallback)
    const fallback = conventions.filter(c => c.fallback)
    const composeFallback = fallback.length > 0 && !hasPrimaryProjectFile(primary, dirs)
    if (composeFallback) {
      fallbackComposed = true
      for (const convention of fallback.filter(c => c.nearestOnly)) {
        const holder = dirs.find(dir => [...own.guides(convention, dir), ...own.rules(convention, dir)].some(path => getFsImplementation().existsSync(path)))
        if (holder !== undefined) nearestHolders[convention.id] = holder
      }
      await composeNamed(fallback, dirs)
    }
    const outerFirst = dirs.reverse()
    const composeChain = async (set: InstructionConvention[]): Promise<void> => {
      for (const dir of outerFirst) {
        const skipProject =
          isNestedWorktree &&
          pathInWorkingPath(dir, canonicalRoot) &&
          !pathInWorkingPath(dir, gitRoot)

        if (isSettingSourceEnabled('projectSettings') && !skipProject) {
          for (const convention of set) {
            if (!own.reads(convention, dir)) continue
            if (convention.nearestOnly && nearestHolders[convention.id] !== dir) continue
            for (const projectPath of own.guides(convention, dir)) {
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

            for (const rulesDir of own.rules(convention, dir)) {
              push(
                await processRulesDir({
                  convention,
                  rulesDir,
                  type: 'Project',
                  processedPaths,
                  includeExternal,
                  conditionalRule: false,
                  diagnostics,
                }),
                convention.family,
                origin,
                chainRoot,
              )
            }
          }
        }

        if (isSettingSourceEnabled('localSettings')) {
          for (const convention of set) {
            if (!own.reads(convention, dir)) continue
            const localPaths =
              convention.localDirFiles?.(dir) ??
              (convention.localDirFile(dir) !== null ? [convention.localDirFile(dir) as string] : [])
            for (const localPath of own.within(convention, dir, localPaths)) {
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

    await composeChain(composeFallback ? [...fallback, ...primary] : primary)
  }

  await walkRootChain(getOriginalCwd(), 'project-walk', true)

  return { entries: result, fallbackComposed, nearestHolders, importedScoped, namedRules, heldShares }
}

const sharesHeldBeside = new WeakMap<InstructionSourceEntry[], ExternalInstructionInclude[]>()

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

    const { entries: result, fallbackComposed, nearestHolders, importedScoped, namedRules, heldShares } = await walkConventions(
      conventionsForProfile(resolution.resolved),
      forceIncludeExternal,
      skippedDuplicates,
      diagnostics,
    )
    sharesHeldBeside.set(result, heldShares)

    const eagerLoadReason = forceIncludeExternal
      ? undefined
      : consumeNextEagerLoadReason()

    lastComposition = {
      resolution,
      adapterId: adapter.id,
      fallbackComposed,
      nearestHolders,
      importedScoped,
      namedRules,
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

    return result
  },
)


export type InstructionsLoadReason = 'session_start' | 'compact'

let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

let nextLoadIsEager = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!nextLoadIsEager) return undefined
  nextLoadIsEager = false
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
  forgetHiddenCharacters('instruction')
  clearExcludeResolutionMemo()
  for (const listener of cacheInvalidationListeners) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
    }
  }
}

export function resetInstructionFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  nextLoadIsEager = true
  clearInstructionFileCaches()
}

export function getLargeInstructionFiles(
  files: InstructionSourceEntry[],
): InstructionSourceEntry[] {
  const cap = getMaxInstructionFileCharacterCount()
  return files.filter(file => file.content.length > cap)
}

export function filterInjectedInstructionFiles(
  files: InstructionSourceEntry[],
): InstructionSourceEntry[] {
  return [...files]
}

export const composeInstructionPrompt = (
  memoryFiles: InstructionSourceEntry[],
  filter?: (type: InstructionFileType) => boolean,
): string => {
  const sections: string[] = []
  const offeredPointers: string[] = []

  for (const entry of memoryFiles) {
    if (filter && !filter(entry.type)) continue
    if (!entry.content) continue
    if (entry.offered !== undefined) {
      offeredPointers.push(entry.content)
      continue
    }
    const suffix =
      entry.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : entry.type === 'Local'
          ? " (user's private project instructions, not checked in)"
          : " (user's private global instructions for all projects)"
    sections.push(`Contents of ${entry.path}${suffix}:\n\n${entry.content.trim()}`)
  }

  if (offeredPointers.length > 0) {
    sections.push(offeredRulesText(offeredPointers))
  }

  return sections.join('\n\n')
}

export async function getManagedAndUserConditionalInstructionRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<InstructionSourceEntry[]> {
  await getInstructionFiles()
  const conventions = activeConventions()
  const results: InstructionSourceEntry[] = []

  for (const convention of conventions) {
    const managedRulesDir = convention.managedRulesDir()
    if (managedRulesDir) {
      results.push(
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
  }

  if (isSettingSourceEnabled('userSettings')) {
    for (const convention of conventions) {
      const userRulesDir = convention.userRulesDir()
      if (userRulesDir) {
        results.push(
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

  for (const { convention, rulesDir, by } of lastComposition.namedRules) {
    const namedEntries = await processConditionedRules(
      convention,
      targetPath,
      rulesDir,
      'User',
      processedPaths,
      true,
    )
    for (const entry of namedEntries) {
      entry.namedBy = by
      results.push(entry)
    }
  }

  for (const entry of lastComposition.importedScoped) {
    const normalized = normalizePathForComparison(entry.path)
    if (processedPaths.has(normalized)) continue
    if (importedRuleGoverns(entry, targetPath)) {
      processedPaths.add(normalized)
      results.push(entry)
    }
  }

  return results
}

export async function getInstructionFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
): Promise<InstructionSourceEntry[]> {
  if (untrustedWorkspaceHeadless()) return []
  await getInstructionFiles()

  const conventions = activeConventions()
  const primary = conventions.filter(c => !c.fallback)
  const fallback = conventions.filter(c => c.fallback)
  const useFallback =
    lastComposition.fallbackComposed &&
    fallback.length > 0 &&
    !hasPrimaryProjectFile(primary, [dir])
  const selected = useFallback ? [...fallback, ...primary] : primary

  const own = folderSources(resolve(getOriginalCwd()))
  const includeExternal = Boolean(getCurrentProjectConfig().hasExternalIncludesApproved)
  const results: InstructionSourceEntry[] = []

  for (const convention of selected) {
    if (!own.reads(convention, dir)) continue
    const convEntries: InstructionSourceEntry[] = []

    if (isSettingSourceEnabled('projectSettings')) {
      for (const projectPath of own.guides(convention, dir)) {
        convEntries.push(
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
      for (const localPath of own.within(convention, dir, localPaths)) {
        convEntries.push(
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

    if (isSettingSourceEnabled('projectSettings')) {
      const unconditionalSeen = new Set(processedPaths)
      for (const rulesDir of own.rules(convention, dir)) {
        convEntries.push(
          ...(await processRulesDir({
            convention,
            rulesDir,
            type: 'Project',
            processedPaths: unconditionalSeen,
            includeExternal: false,
            conditionalRule: false,
            diagnostics,
          })),
        )
        convEntries.push(
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
      for (const seen of unconditionalSeen) processedPaths.add(seen)
    }

    for (const entry of convEntries) {
      if (entry.anchor !== undefined && !importedRuleGoverns(entry, targetPath)) continue
      results.push(entry)
    }
  }

  return results
}

export async function getConditionalInstructionRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<InstructionSourceEntry[]> {
  if (untrustedWorkspaceHeadless()) return []
  await getInstructionFiles()
  if (!isSettingSourceEnabled('projectSettings')) return []

  const conventions = activeConventions()
  const resolvedDir = resolve(dir)
  const own = folderSources(resolve(getOriginalCwd()))
  const seenDigests = new Set<string>()
  const results: InstructionSourceEntry[] = []

  for (const convention of conventions) {
    if (convention.fallback && !lastComposition.fallbackComposed) continue
    if (!own.reads(convention, resolvedDir)) continue
    if (convention.nearestOnly && lastComposition.nearestHolders[convention.id] !== resolvedDir) continue
    for (const rulesDir of own.rules(convention, resolvedDir)) {
      const entries = await processConditionedRules(
        convention,
        targetPath,
        rulesDir,
        'Project',
        processedPaths,
        false,
      )
      for (const entry of entries) {
        const digest = sha256(entry.content)
        if (seenDigests.has(digest)) continue
        seenDigests.add(digest)
        results.push(entry)
      }
    }
  }

  return results
}

export type ExternalInstructionInclude = { path: string; parent: string }

export function getExternalInstructionIncludes(
  files: InstructionSourceEntry[],
): ExternalInstructionInclude[] {
  const includes: ExternalInstructionInclude[] = []
  for (const file of files) {
    if (file.type === 'User') continue
    if (!file.parent) continue
    if (pathInInstructionRoots(file.path)) continue
    includes.push({ path: file.path, parent: file.parent })
  }
  const held = sharesHeldBeside.get(files)
  if (held !== undefined) {
    for (const share of held) {
      includes.push(share)
    }
  }
  return includes
}

export function hasExternalInstructionIncludes(
  files: InstructionSourceEntry[],
): boolean {
  return getExternalInstructionIncludes(files).length > 0
}

export async function shouldShowExternalInstructionIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (config.hasExternalIncludesApproved || config.hasExternalIncludesWarningShown) {
    return false
  }
  const files = await getInstructionFiles(true)
  return hasExternalInstructionIncludes(files)
}

export function isInstructionFilePath(
  filePath: string,
  conventions?: InstructionConvention[],
): boolean {
  const active = conventions ?? activeConventions()
  const normalized = normalizePathForComparison(filePath)
  if (lastComposition.importedScoped.some(entry => normalizePathForComparison(entry.path) === normalized)) {
    return true
  }

  const primary = active.filter(c => !c.fallback)
  const name = basename(filePath)

  for (const convention of active) {
    const folder = convention.instructionFileNames.includes(name)
      ? dirname(filePath)
      : (convention.folderOf?.(filePath) ?? null)
    if (folder !== null) {
      if (!convention.fallback) return true
      if (lastComposition.fallbackComposed && !hasPrimaryProjectFile(primary, [folder])) {
        return true
      }
    }
    if (name.endsWith('.md') && convention.rulesPathMarkers.some(marker => filePath.includes(marker))) {
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
        const disk = readFileSync(f.path).toString(detectEncodingForResolvedPath(f.path))
        if (stripBOM(disk) !== known) continue
        readFileState.set(f.path, {
          content: disk,
          timestamp: Math.floor(statSync(f.path).mtimeMs),
          offset: undefined,
          limit: undefined,
        })
      } catch (error) {
        passedOver(error)
      }
    }
  } catch (error) {
    passedOver(error)
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
    ...(f.convention !== undefined && { convention: f.convention }),
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
  const { entries: files } = await walkConventions(
    conventionsForProfile(resolution.resolved),
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
