import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe, getRemoteUrl, redactGitRemoteCredentials } from './git.js'
import { logError } from './log.js'

export type ParsedRepository = {
  host: string
  owner: string
  name: string
}

const PUBLIC_GIT_HOST = 'github.com'

const repositoryCache = new Map<string, ParsedRepository>()

export function clearRepositoryCaches(): void {
  repositoryCache.clear()
}

function looksLikeRealHostname(host: string): boolean {
  if (!host.includes('.')) return false
  const segments = host.split('.')
  return /^[a-zA-Z]+$/.test(segments[segments.length - 1] as string)
}

export function parseGitRemote(input: string): ParsedRepository | null {
  const trimmed = input.trim()
  const sshMatch = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed)
  if (sshMatch) {
    const host = sshMatch[1] as string
    if (!looksLikeRealHostname(host)) return null
    return { host, owner: sshMatch[2] as string, name: sshMatch[3] as string }
  }
  const urlMatch = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
    trimmed,
  )
  if (urlMatch) {
    const scheme = urlMatch[1] as string
    const bareHost = urlMatch[2] as string
    if (!looksLikeRealHostname(bareHost)) return null
    const port = urlMatch[3]
    const keepPort = (scheme === 'http' || scheme === 'https') && port !== undefined
    return {
      host: keepPort ? `${bareHost}:${port}` : bareHost,
      owner: urlMatch[4] as string,
      name: urlMatch[5] as string,
    }
  }
  return null
}

export function parseGitHubRepository(input: string): string | null {
  const parsed = parseGitRemote(input)
  if (parsed) {
    if (parsed.host === PUBLIC_GIT_HOST) return `${parsed.owner}/${parsed.name}`
    return null
  }
  if (!input.includes('://') && !input.includes('@') && input.includes('/')) {
    const parts = input.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${(parts[1] as string).replace(/\.git$/, '')}`
    }
  }
  logForDebugging(`detectRepository: could not parse repository string: ${input}`)
  return null
}

export async function detectCurrentRepositoryWithHost(cwd?: string): Promise<ParsedRepository | null> {
  try {
    const directory = cwd ?? getCwd()
    const cached = repositoryCache.get(directory)
    if (cached) return cached

    let remoteUrl: string | null = null
    if (cwd === undefined) {
      remoteUrl = await getRemoteUrl()
    }
    if (!remoteUrl) {
      const result = await execFileNoThrowWithCwd(
        gitExe(),
        ['config', '--get', 'remote.origin.url'],
        { cwd: directory, preserveOutputOnError: false },
      )
      remoteUrl = result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
    }
    logForDebugging(`detectRepository: remote url = ${redactGitRemoteCredentials(remoteUrl ?? undefined) ?? 'none'}`)
    if (!remoteUrl) {
      logForDebugging('detectRepository: no remote url found')
      return null
    }
    const parsed = parseGitRemote(remoteUrl)
    logForDebugging(
      `detectRepository: parsed ${redactGitRemoteCredentials(remoteUrl)} → ${parsed ? `${parsed.host}/${parsed.owner}/${parsed.name}` : 'null'}`,
    )
    if (parsed) {
      repositoryCache.set(directory, parsed)
    }
    return parsed
  } catch (err) {
    logError(err)
    return null
  }
}

export async function detectCurrentRepository(): Promise<string | null> {
  const parsed = await detectCurrentRepositoryWithHost()
  if (!parsed || parsed.host !== PUBLIC_GIT_HOST) return null
  return `${parsed.owner}/${parsed.name}`
}

export function getCachedRepository(): string | null {
  const cached = repositoryCache.get(getCwd())
  if (!cached || cached.host !== PUBLIC_GIT_HOST) return null
  return `${cached.owner}/${cached.name}`
}

export function getCachedRepositoryHost(): string | null {
  return repositoryCache.get(getCwd())?.host ?? null
}
