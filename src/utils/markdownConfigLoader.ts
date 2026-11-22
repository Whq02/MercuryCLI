import { statSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd } from '../bootstrap/state.js'
import { addBootNote } from '../substrate/bootNotes.js'
import { discoveryPoolWidth, mapWithConcurrency } from './concurrency.js'
import { getMercuryHome } from './envUtils.js'
import { checkHasTrustDialogAccepted } from './config/trust.js'
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
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/utils/markdownConfigLoader.ts:59')
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
  return notBuilt('src/utils/markdownConfigLoader.ts:117')
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
  return notBuilt('src/utils/markdownConfigLoader.ts:172')
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
  return notBuilt('src/utils/markdownConfigLoader.ts:282')
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
