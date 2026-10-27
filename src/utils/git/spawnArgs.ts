import { execFile, execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gitExe } from '../git.js'
import { subprocessEnv } from '../subprocessEnv.js'

export const GIT_SPAWN_CONFIG = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'] as const
export const GIT_DIFF_CONFIG = ['--no-ext-diff', '--no-textconv'] as const

const VALUE_GLOBALS = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file', '--config-env'])
const PATCH_COMMANDS = new Set(['diff', 'show', 'log', 'format-patch', 'range-diff', 'blame'])
const FILTER_COMMANDS = new Set(['add', 'checkout', 'stash', 'apply', 'merge'])
const NETWORK_COMMANDS = new Set(['fetch', 'ls-remote', 'remote', 'pull', 'push', 'clone', 'submodule', 'archive'])

type RepositoryFilters = {
  fingerprint: string
  skipped: string[]
}

const filterCache = new Map<string, RepositoryFilters>()

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function inside(path: string, directory: string): boolean {
  const rest = relative(canonical(directory), canonical(path))
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let quote = ''
  let escaped = false
  let started = false
  for (const char of command) {
    if (escaped) {
      word += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
      continue
    }
    word += char
    started = true
  }
  if (escaped) word += '\\'
  if (started) words.push(word)
  return words
}

function commandCandidates(command: string): string[] {
  const words = shellWords(command)
  let at = 0
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++
  if (words[at] === 'command' || words[at] === 'env') {
    at++
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || words[at]!.startsWith('-'))) at++
  }
  const executable = words[at]
  if (!executable || /[`$|;&<>()]/.test(executable)) return []
  const candidates = [executable]
  const kind = basename(executable).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
  if (['sh', 'bash', 'zsh', 'ksh', 'python', 'python3', 'node', 'ruby', 'perl'].includes(kind)) {
    const script = words.slice(at + 1).find(word => !word.startsWith('-'))
    if (script && !/[`$|;&<>()]/.test(script)) candidates.push(script)
  }
  return candidates
}

function executablePaths(command: string, root: string): string[] {
  const out: string[] = []
  for (const candidate of commandCandidates(command)) {
    if (isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
      out.push(isAbsolute(candidate) ? candidate : resolve(root, candidate))
      continue
    }
    for (const directory of (subprocessEnv().PATH ?? '').split(delimiter)) {
      if (directory) out.push(join(directory, candidate))
    }
  }
  return out
}

function configFingerprint(paths: string[]): string {
  return paths.map(path => {
    try {
      const stat = statSync(path)
      return `${path}:${stat.mtimeMs}`
    } catch {
      return `${path}:absent`
    }
  }).join('|')
}

type RepositoryLayout = { root: string; gitDir: string; commonDir: string }

const layoutCache = new Map<string, RepositoryLayout>()

function readGitSync(args: string[], cwd: string): string | null {
  try {
    return execFileSync(gitExe(), [...GIT_SPAWN_CONFIG, ...args], {
      cwd,
      encoding: 'utf8',
      env: subprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    })
  } catch {
    return null
  }
}

function readGitAsync(args: string[], cwd: string): Promise<string | null> {
  return new Promise(resolveRead => {
    try {
      execFile(
        gitExe(),
        [...GIT_SPAWN_CONFIG, ...args],
        { cwd, encoding: 'utf8', env: subprocessEnv(), timeout: 5_000, windowsHide: true },
        (error: Error | null, stdout: string) => resolveRead(error ? null : stdout),
      )
    } catch {
      resolveRead(null)
    }
  })
}

const LAYOUT_ARGS = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']
const FILTER_ARGS = ['config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']

function knownLayout(cwd: string): RepositoryLayout | null {
  const known = layoutCache.get(cwd)
  return known && existsSync(known.gitDir) && existsSync(known.commonDir) ? known : null
}

function layoutFrom(cwd: string, facts: string | null): RepositoryLayout | null {
  if (facts === null) return null
  const [rootLine, gitDirLine, commonLine] = facts.split('\n')
  if (!rootLine || !gitDirLine || !commonLine) return null
  const layout = { root: canonical(rootLine), gitDir: canonical(gitDirLine), commonDir: canonical(resolve(cwd, commonLine)) }
  layoutCache.set(cwd, layout)
  return layout
}

function repositoryLayout(cwd: string): RepositoryLayout | null {
  return knownLayout(cwd) ?? layoutFrom(cwd, readGitSync(LAYOUT_ARGS, cwd))
}

async function repositoryLayoutAsync(cwd: string): Promise<RepositoryLayout | null> {
  return knownLayout(cwd) ?? layoutFrom(cwd, await readGitAsync(LAYOUT_ARGS, cwd))
}

function cachedFilters(layout: RepositoryLayout): { fingerprint: string; skipped: string[] | null } {
  const fingerprint = configFingerprint([join(layout.commonDir, 'config'), join(layout.gitDir, 'config.worktree')])
  const cached = filterCache.get(layout.commonDir)
  return { fingerprint, skipped: cached?.fingerprint === fingerprint ? cached.skipped : null }
}

function filtersFrom(layout: RepositoryLayout, fingerprint: string, configured: string | null): string[] {
  const { root, gitDir, commonDir } = layout
  const filters = new Map<string, string[]>()
  for (const line of (configured ?? '').split('\n')) {
    const match = /^filter\.(.+)\.(clean|smudge|process)\s(.*)$/.exec(line)
    if (!match) continue
    const commands = filters.get(match[1]!) ?? []
    commands.push(match[3]!)
    filters.set(match[1]!, commands)
  }
  const skipped = [...filters.entries()].filter(([, commands]) => commands.some(command => executablePaths(command, root).some(path => existsSync(path) && (inside(path, root) || inside(path, gitDir) || inside(path, commonDir))))).map(([name]) => name).sort()
  filterCache.set(commonDir, { fingerprint, skipped })
  return skipped
}

function repositoryFilters(cwd: string): string[] {
  const layout = repositoryLayout(cwd)
  if (layout === null) return []
  const { fingerprint, skipped } = cachedFilters(layout)
  return skipped ?? filtersFrom(layout, fingerprint, readGitSync(FILTER_ARGS, layout.root))
}

async function repositoryFiltersAsync(cwd: string): Promise<string[]> {
  const layout = await repositoryLayoutAsync(cwd)
  if (layout === null) return []
  const { fingerprint, skipped } = cachedFilters(layout)
  return skipped ?? filtersFrom(layout, fingerprint, await readGitAsync(FILTER_ARGS, layout.root))
}

export function gitFilterSkipMessages(cwd: string): string[] {
  return repositoryFilters(cwd).map(name => `filter ${name} skipped: its command lives inside this repository`)
}

function filterArgsOf(names: string[]): string[] {
  return names.flatMap(name => ['clean', 'smudge', 'process'].flatMap(kind => ['-c', `filter.${name}.${kind}=`]))
}

function filterConfig(cwd: string | undefined): string[] {
  if (!cwd) return []
  return filterArgsOf(repositoryFilters(cwd))
}

async function filterConfigAsync(cwd: string | undefined): Promise<string[]> {
  if (!cwd) return []
  return filterArgsOf(await repositoryFiltersAsync(cwd))
}

type ScopedRow = { scope: string; value: string }

function scopedRowsFrom(text: string | null): ScopedRow[] {
  return (text ?? '').split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    return { scope: line.slice(0, tab), value: line.slice(tab + 1) }
  })
}

function scopedConfig(cwd: string, key: string): ScopedRow[] {
  return scopedRowsFrom(readGitSync(['config', '--show-scope', '--get-all', key], cwd))
}

async function scopedConfigAsync(cwd: string, key: string): Promise<ScopedRow[]> {
  return scopedRowsFrom(await readGitAsync(['config', '--show-scope', '--get-all', key], cwd))
}

const repositoryScoped = (row: ScopedRow): boolean => row.scope === 'local' || row.scope === 'worktree'

function networkArgsOf(ssh: ScopedRow[], credentials: ScopedRow[], askPass: ScopedRow[]): string[] {
  const out: string[] = []
  if (ssh.some(repositoryScoped)) {
    const user = ssh.filter(row => !repositoryScoped(row)).at(-1)?.value
    out.push('-c', `core.sshCommand=${user || 'ssh'}`)
  }
  if (credentials.some(repositoryScoped)) {
    out.push('-c', 'credential.helper=')
    for (const row of credentials) {
      if (!repositoryScoped(row)) out.push('-c', `credential.helper=${row.value}`)
    }
  }
  if (askPass.some(repositoryScoped)) {
    const user = askPass.filter(row => !repositoryScoped(row)).at(-1)?.value
    out.push('-c', `core.askPass=${user ?? ''}`)
  }
  return out
}

const NETWORK_KEYS = ['core.sshCommand', 'credential.helper', 'core.askPass'] as const

function networkConfig(command: string, cwd: string | undefined): string[] {
  if (!cwd || !NETWORK_COMMANDS.has(command)) return []
  const [ssh, credentials, askPass] = NETWORK_KEYS.map(key => scopedConfig(cwd, key))
  return networkArgsOf(ssh!, credentials!, askPass!)
}

async function networkConfigAsync(command: string, cwd: string | undefined): Promise<string[]> {
  if (!cwd || !NETWORK_COMMANDS.has(command)) return []
  const [ssh, credentials, askPass] = await Promise.all(NETWORK_KEYS.map(key => scopedConfigAsync(cwd, key)))
  return networkArgsOf(ssh!, credentials!, askPass!)
}

function subcommandIndex(args: string[]): number {
  let at = 0
  while (at < args.length) {
    const word = args[at]!
    if (VALUE_GLOBALS.has(word)) {
      at += 2
      continue
    }
    if (word.startsWith('-')) {
      at++
      continue
    }
    break
  }
  return at
}

type SpawnShape = { command: string; insertAt: number; diff: string[]; base: readonly string[] }

function spawnShape(args: string[]): SpawnShape {
  const at = subcommandIndex(args)
  const command = args[at] ?? ''
  const stashShow = command === 'stash' && args[at + 1] === 'show'
  const patch = PATCH_COMMANDS.has(command) || stashShow
  const insertAt = stashShow ? at + 2 : at + 1
  const diff = patch ? GIT_DIFF_CONFIG.filter(flag => !args.includes(flag)) : []
  const base = args.includes('core.fsmonitor=false') ? [] : GIT_SPAWN_CONFIG
  return { command, insertAt, diff, base }
}

function assemble(args: string[], shape: SpawnShape, filters: string[], network: string[]): string[] {
  return [...shape.base, ...filters, ...network, ...args.slice(0, shape.insertAt), ...shape.diff, ...args.slice(shape.insertAt)]
}

export function gitArgs(args: string[], cwd?: string): string[] {
  const shape = spawnShape(args)
  const filters = FILTER_COMMANDS.has(shape.command) ? filterConfig(cwd) : []
  return assemble(args, shape, filters, networkConfig(shape.command, cwd))
}

export async function gitArgsAsync(args: string[], cwd?: string): Promise<string[]> {
  const shape = spawnShape(args)
  const [filters, network] = await Promise.all([
    FILTER_COMMANDS.has(shape.command) ? filterConfigAsync(cwd) : Promise.resolve([] as string[]),
    networkConfigAsync(shape.command, cwd),
  ])
  return assemble(args, shape, filters, network)
}

export function isGitExecutable(file: string): boolean {
  return /^git(?:\.(?:exe|cmd|bat))?$/i.test(basename(file))
}
