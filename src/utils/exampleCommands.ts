import { memoize, sample } from 'lodash-es'

import { getCurrentProjectConfig, saveCurrentProjectConfig } from './config.js'
import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { logError } from './log.js'
import { getGitEmail } from './user.js'

/**
 * The rotating example-prompt placeholder and the background refresh of its
 * cached repository filenames.
 */

/**
 * Non-core file patterns: a path is a core file when it matches NONE of
 * them. Anchoring is "at a path segment boundary" (start of string or after
 * a forward slash) unless noted. Reproducing the table is the only way to
 * reproduce which filenames the placeholder offers.
 */
const NON_CORE_PATTERNS: RegExp[] = [
  // Lock / dependency manifests (exact basenames).
  /(^|\/)(package-lock\.json|yarn\.lock|bun\.lock|bun\.lockb|pnpm-lock\.yaml|Pipfile\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/,
  // Generated marker anywhere.
  /\.generated\./,
  // Build output directories.
  /(^|\/)(dist|build|out|target|node_modules|\.next|__pycache__)\//,
  // Compiled / derived extensions.
  /\.(min\.js|min\.css|map|pyc|pyo)$/,
  // Data / docs / config extensions (case-insensitive).
  /\.(json|ya?ml|toml|xml|ini|cfg|conf|env|lock|txt|md|mdx|rst|csv|log|svg)$/i,
  // Tool dotfiles (prefix match at a segment, optional leading dot, NOT
  // anchored at end).
  /(^|\/)\.?(eslintrc|prettierrc|babelrc|editorconfig|gitignore|gitattributes|dockerignore|npmrc)/,
  // Named config files (basename plus one lowercase extension).
  /(^|\/)(tsconfig|jsconfig|biome|vitest\.config|jest\.config|webpack\.config|vite\.config|rollup\.config)\.[a-z]+$/,
  // Tool directories — the last is the COMPATIBILITY project home spelling,
  // kept as-is because it is what such a repository actually contains.
  /(^|\/)(\.github|\.vscode|\.idea|\.claude)\//,
  // Docs / legal (basename, optional single lowercase extension, case-insensitive).
  /(^|\/)(CHANGELOG|LICENSE|CONTRIBUTING|CODEOWNERS|README)(\.[a-z]+)?$/i,
]

function isCoreFile(path: string): boolean {
  return NON_CORE_PATTERNS.every(pattern => !pattern.test(path))
}

function splitPath(path: string): { dir: string; base: string } {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastSlash === -1) return { dir: '.', base: path }
  return { dir: path.slice(0, lastSlash), base: path.slice(lastSlash + 1) }
}

/**
 * Greedily pick base names from frequency-sorted paths, skipping non-core
 * files and already-picked names, spreading across directories by raising a
 * per-directory cap by one on each pass — so the busiest directory cannot
 * supply the whole list, yet a single-directory repository can still fill
 * it. Empty unless the wanted count was reached.
 */
export function pickDiverseCoreFiles(sortedPaths: string[], want: number): string[] {
  const picked: string[] = []
  const pickedNames = new Set<string>()
  const perDirectory = new Map<string, number>()
  const candidates = sortedPaths.filter(isCoreFile)
  for (let cap = 1; picked.length < want; cap++) {
    let progressed = false
    for (const path of candidates) {
      if (picked.length >= want) break
      const { dir, base } = splitPath(path)
      if (pickedNames.has(base)) continue
      if ((perDirectory.get(dir) ?? 0) >= cap) continue
      picked.push(base)
      pickedNames.add(base)
      perDirectory.set(dir, (perDirectory.get(dir) ?? 0) + 1)
      progressed = true
    }
    if (!progressed) break
  }
  return picked.length >= want ? picked : []
}

async function tallyGitHistory(args: string[], useResolvedGit: boolean, counts: Map<string, number>): Promise<void> {
  // The author-restricted pass invokes git by bare name while the fallback
  // goes through the shared resolver — reproduced as built (recorded as a
  // probable defect: on a host where git is off PATH under its bare name
  // the first pass silently yields nothing).
  const result = await execFileNoThrow(useResolvedGit ? gitExe() : 'git', args)
  // Output presence, not exit status, gates the tally: whatever stdout the
  // query produced is counted even on a non-zero exit.
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
}

/** Best-effort frequency gathering; empty in tests, on Windows, or outside git. */
async function gatherFrequentFiles(): Promise<string[]> {
  try {
    if (process.env.NODE_ENV === 'test') return []
    if (env.platform === 'win32') return []
    if (!(await getIsGit())) return []
    const counts = new Map<string, number>()
    const email = await getGitEmail()
    if (email) {
      await tallyGitHistory(
        ['log', '-n', '1000', `--author=${email}`, '--pretty=format:', '--name-only', '--diff-filter=M'],
        false,
        counts,
      )
    }
    // Under ten distinct paths: tally all authors into the SAME map (an
    // addition, not a replacement — the user's own files end up double
    // counted, biasing the pick toward them).
    if (counts.size < 10) {
      await tallyGitHistory(
        ['log', '-n', '1000', '--pretty=format:', '--name-only', '--diff-filter=M'],
        true,
        counts,
      )
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path)
    return pickDiverseCoreFiles(sorted, 5)
  } catch (err) {
    logError(err)
    return []
  }
}

/**
 * Count occurrences, sort descending, take the top N, and format each as a
 * right-aligned six-character count, a space, and the item.
 */
export function countAndSortItems(items: string[], topN: number = 20): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([item, count]) => `${String(count).padStart(6, ' ')} ${item}`)
    .join('\n')
}

/**
 * The placeholder, memoized per process. Generic prompts are kept alongside
 * four fork-specific ones naming the product's own surfaces — the surface
 * an idle operator looks at most should not read as the product this one
 * forked from.
 */
export const getExampleCommandFromCache = memoize((): string => {
  const cached = getCurrentProjectConfig().exampleFiles ?? []
  const file = cached.length > 0 ? (sample(cached) as string) : '<filepath>'
  const candidates = [
    'fix lint errors',
    'fix typecheck errors',
    `how does ${file} work?`,
    `refactor ${file}`,
    'how do I log an error?',
    `edit ${file} to...`,
    `write a test for ${file}`,
    'create a util logging.py that...',
    'open /cockpit',
    'check /trace for recent runs',
    `walk me through ${file}`,
    'what is the substrate status?',
  ]
  return `Try "${sample(candidates) as string}"`
})

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Refresh the cached example files: an over-a-week-old cache is cleared in
 * memory only (reproduced as built — only the re-gather's success path
 * saves); an empty cache kicks off background gathering and saves any
 * result with a fresh timestamp.
 */
export const refreshExampleCommands = memoize(async (): Promise<void> => {
  const config = getCurrentProjectConfig()
  const generatedAt = config.exampleFilesGeneratedAt ?? 0
  if (Date.now() - generatedAt > ONE_WEEK_MS) {
    config.exampleFiles = []
  }
  if (!config.exampleFiles || config.exampleFiles.length === 0) {
    const files = await gatherFrequentFiles()
    if (files.length > 0) {
      saveCurrentProjectConfig(current => ({
        ...current,
        exampleFiles: files,
        exampleFilesGeneratedAt: Date.now(),
      }))
    }
  }
})
