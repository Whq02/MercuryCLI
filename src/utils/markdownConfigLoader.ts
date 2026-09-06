
import { statSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd } from '../bootstrap/state.js'
import { addBootNote } from '../substrate/bootNotes.js'
import { discoveryPoolWidth, mapWithConcurrency } from './concurrency.js'
import { getMercuryHome } from './envUtils.js'
import { normalizePathForComparison } from './file.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { parseFrontmatter, type FrontmatterData } from './frontmatterParser.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { isRestrictedToExtensionsOnly } from './settings/extensionOnlyPolicy.js'
import {
  MERCURY_PROJECT_DIR,
  PROJECT_CONFIG_DIR_NAMES,
} from './projectConfig.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'

export const MERCURY_CONFIG_DIRECTORIES = [
  'agents',
  'skills',
  'workflows',
] as const

export type MercuryConfigDirectory = (typeof MERCURY_CONFIG_DIRECTORIES)[number]

export type MarkdownFile = {
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  rawContent: string
  source: 'policySettings' | 'userSettings' | 'projectSettings'
  parseError?: { message: string }
}


export function extractDescriptionFromMarkdown(
  content: string,
  defaultDescription: string = 'a custom configuration',
): string {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const withoutHeading = line.replace(/^#+ +/, '')
    if (withoutHeading.length > 100) return `${withoutHeading.slice(0, 97)}...`
    return withoutHeading
  }
  return defaultDescription
}


function toToolStrings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return undefined
}

export function parseAgentToolsFromFrontmatter(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return []
  if (value === false) return []
  if (value === true) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>).filter(k => k.trim() !== '')
    if (keys.length === 0) return []
    const parsedKeys = parseToolListFromCLI(keys)
    return parsedKeys.includes('*') ? undefined : parsedKeys
  }
  const raw = toToolStrings(value)
  if (raw === undefined) return []
  const parsed = parseToolListFromCLI(raw)
  if (parsed.includes('*')) return undefined
  return parsed
}

export function agentToolsFrontmatterProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' || typeof value === 'boolean') return null
  if (Array.isArray(value)) {
    const dropped = value.filter(v => typeof v !== 'string').length
    return dropped > 0 ? `a list carrying ${dropped} non-string entr${dropped === 1 ? 'y' : 'ies'}` : null
  }
  if (typeof value === 'object') return null
  return `a ${typeof value} where a tool list belongs`
}

export function parseSlashCommandToolsFromFrontmatter(value: unknown): string[] {
  const raw = toToolStrings(value)
  if (raw === undefined) return []
  const parsed = parseToolListFromCLI(raw)
  if (parsed.includes('*')) return ['*']
  return parsed
}


function configDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return false
    }
    throw error
  }
}

function isInsideTree(path: string, root: string): boolean {
  const normalizedPath = normalizePathForComparison(path)
  const normalizedRoot = normalizePathForComparison(root)
  return (
    normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
  )
}

export function getProjectDirsUpToHome(subdir: string, cwd: string): string[] {
  const home = normalizePathForComparison(resolve(homedir()).normalize('NFC'))
  const nearestRoot = findGitRoot(cwd)

  let boundary = nearestRoot
  if (nearestRoot) {
    const sessionRoot = findGitRoot(getOriginalCwd())
    if (
      sessionRoot &&
      normalizePathForComparison(nearestRoot) !== normalizePathForComparison(sessionRoot)
    ) {
      const nearestCanonical = findCanonicalGitRoot(nearestRoot)
      const sessionCanonical = findCanonicalGitRoot(sessionRoot)
      if (
        nearestCanonical &&
        sessionCanonical &&
        normalizePathForComparison(nearestCanonical) !==
          normalizePathForComparison(sessionCanonical) &&
        isInsideTree(nearestRoot, sessionRoot)
      ) {
        boundary = sessionRoot
      }
    }
  }

  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    if (normalizePathForComparison(current) === home) break
    for (const homeName of PROJECT_CONFIG_DIR_NAMES) {
      const candidate = join(current, homeName, subdir)
      if (configDirExists(candidate)) dirs.push(candidate)
    }
    if (boundary && normalizePathForComparison(current) === normalizePathForComparison(boundary)) {
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}


export const ESTATE_WALK_MAX_ENTRIES = 8_000
export const ESTATE_WALK_MAX_DEPTH = 12
const ESTATE_WALK_BUDGET_MS = 3_000

export interface EstateWalk {
  files: string[]
  complete: boolean
  reason?: string
  entries: number
}

export async function walkMarkdownEstate(dir: string): Promise<EstateWalk> {
  const out: string[] = []
  const visited = new Set<string>()
  const startedAt = Date.now()
  let entries = 0
  let stopped: string | undefined
  let pruned: string | undefined
  const walk = async (current: string, depth: number): Promise<void> => {
    if (stopped) return
    if (depth > ESTATE_WALK_MAX_DEPTH) {
      pruned ??= `depth ${ESTATE_WALK_MAX_DEPTH} exceeded at ${current}`
      return
    }
    if (Date.now() - startedAt > ESTATE_WALK_BUDGET_MS) {
      stopped = `the ${ESTATE_WALK_BUDGET_MS} ms budget was spent at ${current}`
      return
    }
    let key: string
    try {
      const info = await stat(current, { bigint: true })
      key = `${info.dev}:${info.ino}`
      if (key === '0:0') {
        key = await realpath(current)
      }
    } catch {
      try {
        key = await realpath(current)
      } catch (error) {
        logForDebugging(`markdownConfigLoader: skipping unreadable ${current}: ${String(error)}`)
        return
      }
    }
    if (visited.has(key)) return
    visited.add(key)
    let listing
    try {
      listing = await readdir(current, { withFileTypes: true })
    } catch (error) {
      logForDebugging(`markdownConfigLoader: skipping unreadable ${current}: ${String(error)}`)
      return
    }
    for (const entry of listing) {
      if (stopped) return
      if (++entries > ESTATE_WALK_MAX_ENTRIES) {
        stopped = `${ESTATE_WALK_MAX_ENTRIES} entries examined, the last under ${current}`
        return
      }
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isSymbolicLink()) {
        try {
          const info = await stat(full)
          if (info.isDirectory()) await walk(full, depth + 1)
          else if (info.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full)
        } catch (error) {
          logForDebugging(`markdownConfigLoader: skipping unreadable ${full}: ${String(error)}`)
        }
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  await walk(dir, 0)
  out.sort()
  const reason = stopped ?? pruned
  return reason ? { files: out, complete: false, reason, entries } : { files: out, complete: true, entries }
}

async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const walk = await walkMarkdownEstate(dir)
  if (!walk.complete) {
    const note = `the configuration walk under ${dir} stopped early (${walk.reason}) — ${walk.files.length} markdown file(s) kept, the estate beyond the cap is not loaded`
    logError(new Error(`markdownConfigLoader: ${note}`))
    addBootNote('warn', note)
  }
  return walk.files
}

async function loadDirectory(
  dir: string,
  source: MarkdownFile['source'],
): Promise<MarkdownFile[]> {
  const paths = await discoverMarkdownFiles(dir)
  const loaded = await mapWithConcurrency(
    paths,
    discoveryPoolWidth() * 4,
    async filePath => {
      try {
        const rawContent = await readFile(filePath, 'utf8')
        const parsed = parseFrontmatter(rawContent, filePath)
        return {
          filePath,
          baseDir: dir,
          frontmatter: parsed.frontmatter,
          content: parsed.content,
          rawContent,
          source,
          ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
        } satisfies MarkdownFile
      } catch (error) {
        logForDebugging(`markdownConfigLoader: dropping ${filePath}: ${String(error)}`)
        return null
      }
    },
  )
  return loaded.filter((f): f is MarkdownFile => f !== null)
}


async function dedupeByIdentity(files: MarkdownFile[]): Promise<MarkdownFile[]> {
  const identities = await Promise.all(
    files.map(async file => {
      try {
        const info = await lstat(file.filePath, { bigint: true })
        if (info.dev === 0n && info.ino === 0n) return null
        return `${info.dev}:${info.ino}`
      } catch {
        return null
      }
    }),
  )
  const seen = new Map<string, MarkdownFile>()
  const out: MarkdownFile[] = []
  let dropped = 0
  for (let i = 0; i < files.length; i++) {
    const identity = identities[i]
    const file = files[i]!
    if (identity === null) {
      out.push(file)
      continue
    }
    const prior = seen.get(identity)
    if (prior) {
      dropped++
      logForDebugging(
        `markdownConfigLoader: duplicate ${file.filePath} (${file.source}) already provided by ${prior.source}`,
      )
      continue
    }
    seen.set(identity, file)
    out.push(file)
  }
  if (dropped > 0) {
    logForDebugging(`markdownConfigLoader: removed ${dropped} duplicate file(s)`)
  }
  return out
}


async function loadMarkdownFilesUncached(subdir: string, cwd: string): Promise<MarkdownFile[]> {
  const managedRoot = getManagedFilePath()
  const managedDir = join(managedRoot, MERCURY_PROJECT_DIR, subdir)

  const agentsAllowed = subdir !== 'agents' || !isRestrictedToExtensionsOnly('agents')
  const userAllowed = isSettingSourceEnabled('userSettings') && agentsAllowed
  const projectAllowed = isSettingSourceEnabled('projectSettings') && agentsAllowed

  const projectDirs = projectAllowed ? getProjectDirsUpToHome(subdir, cwd) : []

  if (projectAllowed) {
    const worktreeRoot = findGitRoot(cwd)
    const canonicalRoot = findCanonicalGitRoot(cwd)
    if (
      worktreeRoot &&
      canonicalRoot &&
      normalizePathForComparison(worktreeRoot) !== normalizePathForComparison(canonicalRoot)
    ) {
      for (const homeName of PROJECT_CONFIG_DIR_NAMES) {
        const worktreeCopy = join(worktreeRoot, homeName, subdir)
        if (!projectDirs.some(d => normalizePathForComparison(d) === normalizePathForComparison(worktreeCopy))) {
          projectDirs.push(join(canonicalRoot, homeName, subdir))
        }
      }
    }
  }

  const [managed, user, project] = await Promise.all([
    loadDirectory(managedDir, 'policySettings'),
    userAllowed
      ? loadDirectory(join(getMercuryHome(), subdir), 'userSettings')
      : Promise.resolve([] as MarkdownFile[]),
    Promise.all(projectDirs.map(dir => loadDirectory(dir, 'projectSettings'))).then(groups =>
      groups.flat(),
    ),
  ])

  return dedupeByIdentity([...managed, ...user, ...project])
}

export const loadMarkdownFilesForSubdir = memoize(
  (subdir: string, cwd: string): Promise<MarkdownFile[]> =>
    loadMarkdownFilesUncached(subdir, cwd),
  (subdir: string, cwd: string) => `${subdir}|${cwd}`,
)

export function clearMarkdownFileCache(): void {
  loadMarkdownFilesForSubdir.cache.clear?.()
}
