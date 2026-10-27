import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { subprocessEnv } from '../subprocessEnv.js'

export const GIT_SPAWN_CONFIG = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'] as const
export const GIT_DIFF_CONFIG = ['--no-ext-diff', '--no-textconv'] as const

const VALUE_GLOBALS = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file', '--config-env'])
const PATCH_COMMANDS = new Set(['diff', 'show', 'log', 'format-patch', 'range-diff', 'blame'])
const FILTER_COMMANDS = new Set(['add', 'checkout', 'stash', 'apply', 'merge'])
const NETWORK_COMMANDS = new Set(['fetch', 'ls-remote'])

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

function repositoryFilters(cwd: string): string[] {
  let facts: string
  try {
    facts = execFileSync('git', [...GIT_SPAWN_CONFIG, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      env: subprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    })
  } catch {
    return []
  }
  const [rootLine, gitDirLine, commonLine] = facts.split('\n')
  if (!rootLine || !gitDirLine || !commonLine) return []
  const root = canonical(rootLine)
  const gitDir = canonical(gitDirLine)
  const commonDir = canonical(resolve(cwd, commonLine))
  const fingerprint = configFingerprint([join(commonDir, 'config'), join(gitDir, 'config.worktree')])
  const cached = filterCache.get(commonDir)
  if (cached?.fingerprint === fingerprint) return cached.skipped
  let configured = ''
  try {
    configured = execFileSync('git', [...GIT_SPAWN_CONFIG, 'config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], {
      cwd: root,
      encoding: 'utf8',
      env: subprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    })
  } catch {}
  const filters = new Map<string, string[]>()
  for (const line of configured.split('\n')) {
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

export function gitFilterSkipMessages(cwd: string): string[] {
  return repositoryFilters(cwd).map(name => `filter ${name} skipped: its command lives inside this repository`)
}

function filterConfig(cwd: string | undefined): string[] {
  if (!cwd) return []
  return repositoryFilters(cwd).flatMap(name => ['clean', 'smudge', 'process'].flatMap(kind => ['-c', `filter.${name}.${kind}=`]))
}

function scopedConfig(cwd: string, key: string): Array<{ scope: string; value: string }> {
  try {
    return execFileSync('git', [...GIT_SPAWN_CONFIG, 'config', '--show-scope', '--get-all', key], {
      cwd,
      encoding: 'utf8',
      env: subprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    }).split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t')
      return { scope: line.slice(0, tab), value: line.slice(tab + 1) }
    })
  } catch {
    return []
  }
}

function networkConfig(command: string, cwd: string | undefined): string[] {
  if (!cwd || !NETWORK_COMMANDS.has(command)) return []
  const out: string[] = []
  const ssh = scopedConfig(cwd, 'core.sshCommand')
  if (ssh.some(row => row.scope === 'local' || row.scope === 'worktree')) {
    const user = ssh.filter(row => row.scope !== 'local' && row.scope !== 'worktree').at(-1)?.value
    out.push('-c', `core.sshCommand=${user || 'ssh'}`)
  }
  const credentials = scopedConfig(cwd, 'credential.helper')
  if (credentials.some(row => row.scope === 'local' || row.scope === 'worktree')) {
    out.push('-c', 'credential.helper=')
    for (const row of credentials) {
      if (row.scope !== 'local' && row.scope !== 'worktree') out.push('-c', `credential.helper=${row.value}`)
    }
  }
  return out
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

export function gitArgs(args: string[], cwd?: string): string[] {
  const at = subcommandIndex(args)
  const command = args[at] ?? ''
  const stashShow = command === 'stash' && args[at + 1] === 'show'
  const patch = PATCH_COMMANDS.has(command) || stashShow
  const insertAt = stashShow ? at + 2 : at + 1
  const diff = patch ? GIT_DIFF_CONFIG.filter(flag => !args.includes(flag)) : []
  const filters = FILTER_COMMANDS.has(command) ? filterConfig(cwd) : []
  const base = args.includes('core.fsmonitor=false') ? [] : GIT_SPAWN_CONFIG
  return [...base, ...filters, ...networkConfig(command, cwd), ...args.slice(0, insertAt), ...diff, ...args.slice(insertAt)]
}

export function isGitExecutable(file: string): boolean {
  return /^git(?:\.(?:exe|cmd|bat))?$/i.test(basename(file))
}
