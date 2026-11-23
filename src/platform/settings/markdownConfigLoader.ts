import { statSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { addBootNote } from '../substrate/bootNotes.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../async/concurrency.js'
import { getMercuryHome } from '../environment/envUtils.js'
import { checkHasTrustDialogAccepted } from '../config/trust.js'
import { normalizePathForComparison } from '../files/file.js'
import { findCanonicalGitRoot, findGitRoot } from '../git/git.js'
import { parseFrontmatter, type FrontmatterData } from '../text/frontmatterParser.js'
import { parseToolListFromCLI } from '../../permissions/rules/permissionSetup.js'
import { getManagedFilePath } from './managedPath.js'
import { isSettingSourceEnabled } from './settingSources.js'
import { isRestrictedToExtensionsOnly } from './extensionOnlyPolicy.js'
import {
  MERCURY_PROJECT_DIR,
  PROJECT_CONFIG_DIR_NAMES,
} from './projectConfig.js'
import { logForDebugging } from '../logs/debugLog.js'
import { logError } from '../logs/errorLog.js'
import { passedOver, passedOverAs } from '../errors/passedOver.js'

type MarkdownFile = {
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
  if (value === undefined || value === true) return undefined
  if (value === null || value === false || value === '') return []
  const names = typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter(key => key.trim() !== '')
    : toToolStrings(value)
  if (!names?.length) return []
  const parsed = parseToolListFromCLI(names)
  return parsed.includes('*') ? undefined : parsed
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
  let level = resolve(cwd)
  const home = normalizePathForComparison(resolve(homedir()).normalize('NFC'))
  let boundary = findGitRoot(cwd)
  if (boundary !== null) {
    const outer = findGitRoot(getOriginalCwd())
    if (outer !== null && normalizePathForComparison(outer) !== normalizePathForComparison(boundary) && isInsideTree(boundary, outer)) {
      const innerRoot = findCanonicalGitRoot(boundary)
      const outerRoot = findCanonicalGitRoot(outer)
      if (innerRoot !== null && outerRoot !== null && normalizePathForComparison(innerRoot) !== normalizePathForComparison(outerRoot)) boundary = outer
    }
  }
  const limit = boundary === null ? null : normalizePathForComparison(boundary)
  const dirs: string[] = []
  for (;;) {
    const key = normalizePathForComparison(level)
    if (key === home) break
    for (const name of PROJECT_CONFIG_DIR_NAMES) {
      const path = join(level, name, subdir)
      if (configDirExists(path)) dirs.push(path)
    }
    if (key === limit) break
    const parent = dirname(level)
    if (normalizePathForComparison(parent) === key) break
    level = parent
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
  const started = Date.now()
  const visited = new Set<string>()
  const files: string[] = []
  let entries = 0
  let stopped: string | undefined
  let depthLimit: string | undefined
  const skip = (path: string, error: unknown) => logForDebugging(`markdownConfigLoader: skipping unreadable ${path}: ${String(error)}`)
  async function visit(folder: string, depth: number): Promise<void> {
    if (stopped) return
    if (depth > ESTATE_WALK_MAX_DEPTH) {
      depthLimit ??= `depth ${ESTATE_WALK_MAX_DEPTH} exceeded at ${folder}`
      return
    }
    if (Date.now() - started > ESTATE_WALK_BUDGET_MS) {
      stopped = `the ${ESTATE_WALK_BUDGET_MS} ms budget was spent at ${folder}`
      return
    }
    let children
    try {
      const info = await stat(folder).catch(passedOverAs(null))
      const id = info && (info.dev !== 0 || info.ino !== 0) ? `${info.dev}:${info.ino}` : await realpath(folder)
      if (visited.has(id)) return
      visited.add(id)
      children = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      skip(folder, error)
      return
    }
    for (const entry of children) {
      if (stopped) return
      if (++entries > ESTATE_WALK_MAX_ENTRIES) {
        stopped = `${ESTATE_WALK_MAX_ENTRIES} entries examined, the last under ${folder}`
        return
      }
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path)
          if (target.isDirectory()) await visit(path, depth + 1)
          else if (target.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
        } catch (error) {
          skip(path, error)
        }
      } else if (entry.name.toLowerCase().endsWith('.md')) files.push(path)
    }
  }
  await visit(dir, 0)
  const reason = stopped ?? depthLimit
  return { files: files.sort(), entries, complete: reason === undefined, ...(reason === undefined ? {} : { reason }) }
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
  const seen = new Map<string, MarkdownFile['source']>()
  const kept: MarkdownFile[] = []
  for (const file of files) {
    try {
      const { dev, ino } = await lstat(file.filePath)
      if (dev !== 0 || ino !== 0) {
        const key = `${dev}:${ino}`
        const first = seen.get(key)
        if (first !== undefined) {
          logForDebugging(`markdownConfigLoader: duplicate ${file.filePath} (${file.source}) already provided by ${first}`)
          continue
        }
        seen.set(key, file.source)
      }
    } catch (error) {
      passedOver(error)
    }
    kept.push(file)
  }
  if (files.length !== kept.length) logForDebugging(`markdownConfigLoader: removed ${files.length - kept.length} duplicate file(s)`)
  return kept
}


async function loadMarkdownFilesUncached(subdir: string, cwd: string): Promise<MarkdownFile[]> {
  const managedRoot = getManagedFilePath()
  const managedDir = join(managedRoot, MERCURY_PROJECT_DIR, subdir)

  const agentsAllowed = subdir !== 'agents' || !isRestrictedToExtensionsOnly('agents')
  const userAllowed = isSettingSourceEnabled('userSettings') && agentsAllowed
  const projectAllowed = isSettingSourceEnabled('projectSettings') && agentsAllowed && (subdir !== 'commands' || checkHasTrustDialogAccepted())

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
  (subdir: string, cwd: string) => `${subdir}|${cwd}|${subdir === 'commands' ? checkHasTrustDialogAccepted() : ''}`,
)

export function clearMarkdownFileCache(): void {
  loadMarkdownFilesForSubdir.cache.clear?.()
}
