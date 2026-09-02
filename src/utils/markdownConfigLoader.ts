
import { statSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd } from '../bootstrap/state.js'
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
import { ripGrepAnswer } from './ripgrep.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'

export const MERCURY_CONFIG_DIRECTORIES = [
  'commands',
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


const DISCOVERY_TIMEOUT_MS = 3000

async function nativeWalk(dir: string): Promise<string[]> {
  const out: string[] = []
  const visited = new Set<string>()
  const walk = async (current: string): Promise<void> => {
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
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      logForDebugging(`markdownConfigLoader: skipping unreadable ${current}: ${String(error)}`)
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isSymbolicLink()) {
        try {
          const resolved = await realpath(full)
          const info = await stat(resolved)
          if (info.isDirectory()) await walk(resolved)
          else if (resolved.toLowerCase().endsWith('.md')) out.push(full)
        } catch (error) {
          logForDebugging(`markdownConfigLoader: skipping unreadable ${full}: ${String(error)}`)
        }
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const files = await (async (): Promise<string[]> => {
    try {
      const answer = await ripGrepAnswer(
        ['--files', '--hidden', '--follow', '--no-ignore', '--iglob', '*.md'],
        dir,
        AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      )
      if (!answer.complete) {
        logError(new Error(`markdownConfigLoader: the discovery walk under ${dir} did not finish (${answer.reason ?? 'unknown'}) — walking natively`))
        return nativeWalk(dir)
      }
      return answer.lines
    } catch (error) {
      if (isSearchBinaryMissing(error)) {
        logForDebugging(`markdownConfigLoader: search binary unavailable — walking ${dir} natively`)
        return nativeWalk(dir)
      }
      logError(error)
      logForDebugging(`markdownConfigLoader: discovery refused under ${dir} — walking natively`, { level: 'error' })
      return nativeWalk(dir)
    }
  })()
  return files.sort()
}

function isSearchBinaryMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const text = String((error as { message?: unknown } | null)?.message ?? error)
  return code === 'ENOENT' || text.includes('search binary was not found')
}

async function loadDirectory(
  dir: string,
  source: MarkdownFile['source'],
): Promise<MarkdownFile[]> {
  const paths = await discoverMarkdownFiles(dir)
  const loaded = await Promise.all(
    paths.map(async filePath => {
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
    }),
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
