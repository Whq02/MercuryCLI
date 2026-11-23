import { memoize, sample } from 'lodash-es'

import { getCurrentProjectConfig, saveCurrentProjectConfig } from './config.js'
import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { logError } from './log.js'
import { getGitEmail } from './user.js'

const NON_CORE_PATTERNS = [
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lock|bun\.lockb|pnpm-lock\.yaml|Pipfile\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/,
  /\.generated\./,
  /(?:^|\/)(?:dist|build|out|target|node_modules|\.next|__pycache__)(?:\/|$)/,
  /\.(?:min\.js|min\.css|map|pyc|pyo)$/,
  /\.(?:json|yaml|yml|toml|xml|ini|cfg|conf|env|lock|txt|md|mdx|rst|csv|log|svg)$/i,
  /(?:^|\/)\.?(?:eslintrc|prettierrc|babelrc|editorconfig|gitignore|gitattributes|dockerignore|npmrc)/,
  /(?:^|\/)(?:tsconfig|jsconfig|biome|vitest\.config|jest\.config|webpack\.config|vite\.config|rollup\.config)\.[a-z]+$/,
  /(?:^|\/)(?:\.github|\.vscode|\.idea)(?:\/|$)/,
  /(?:^|\/)(?:CHANGELOG|LICENSE|CONTRIBUTING|CODEOWNERS|README)(?:\.[a-z]+)?$/i,
]

function splitPath(path: string): { dir: string; base: string } {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastSlash === -1) return { dir: '.', base: path }
  return { dir: path.slice(0, lastSlash), base: path.slice(lastSlash + 1) }
}

async function tallyGitHistory(args: string[], useResolvedGit: boolean, counts: Map<string, number>): Promise<void> {
  const result = await execFileNoThrow(useResolvedGit ? gitExe() : 'git', args)
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
  }
}

function chooseFiles(paths: string[], count: number): string[] {
  const core = paths.filter(path => !NON_CORE_PATTERNS.some(pattern => pattern.test(path))).map(splitPath)
  const names = new Set<string>()
  const dirCounts = new Map<string, number>()
  for (let allowance = 1; names.size < count; allowance++) {
    const before = names.size
    for (const { dir, base } of core) {
      const used = dirCounts.get(dir) ?? 0
      if (used >= allowance || names.has(base)) continue
      names.add(base)
      dirCounts.set(dir, used + 1)
      if (names.size === count) return [...names]
    }
    if (names.size === before) break
  }
  return []
}

async function gatherFiles(): Promise<string[]> {
  try {
    if (process.env.NODE_ENV === 'test' || env.platform === 'win32' || !(await getIsGit())) return []
    const counts = new Map<string, number>()
    const email = await getGitEmail()
    const flags = ['--pretty=format:', '--name-only', '--diff-filter=M']
    if (email) await tallyGitHistory(['log', '-n', '1000', `--author=${email}`, ...flags], false, counts)
    if (counts.size < 10) await tallyGitHistory(['log', '-n', '1000', ...flags], true, counts)
    const paths = [...counts].sort((a, b) => b[1] - a[1]).map(([path]) => path)
    return chooseFiles(paths, 5)
  } catch (error) {
    logError(error)
    return []
  }
}

export const getExampleCommandFromCache = memoize((): string => {
  const files = getCurrentProjectConfig().exampleFiles ?? []
  const file = files.length ? sample(files)! : '<filepath>'
  const example = sample([
    'fix lint errors',
    'fix typecheck errors',
    `how does ${file} work?`,
    `refactor ${file}`,
    'how do I log an error?',
    `edit ${file} to...`,
    `write a test for ${file}`,
    'create a util logging.py that...',
    'check /trace for recent runs',
    `walk me through ${file}`,
    'what is the substrate status?',
  ])
  return `Try "${example}"`
})

export const refreshExampleCommands = memoize(async (): Promise<void> => {
  const config = getCurrentProjectConfig()
  if (Date.now() - (config.exampleFilesGeneratedAt ?? 0) > 604_800_000) config.exampleFiles = []
  if (config.exampleFiles?.length) return
  const files = await gatherFiles()
  if (files.length) saveCurrentProjectConfig(current => ({ ...current, exampleFiles: files, exampleFilesGeneratedAt: Date.now() }))
})
