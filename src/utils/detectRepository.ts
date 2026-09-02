import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe, getRemoteUrl, redactGitRemoteCredentials } from './git.js'
import { logError } from './log.js'

/**
 * Detect and cache the current git remote's host/owner/name; parse remote
 * URLs.
 */
export type ParsedRepository = {
  host: string
  owner: string
  name: string
}

// The public host literal: downstream consumers construct public URLs.
const PUBLIC_GIT_HOST = 'github.com'

// Directory → parsed repository. Only POSITIVE parses are cached: a
// directory with no repository is re-probed on every call, which is what
// lets a remote added later start resolving on its own.
const repositoryCache = new Map<string, ParsedRepository>()

export function clearRepositoryCaches(): void {
  repositoryCache.clear()
}

/** A hostname must contain a dot and end in a letters-only segment — a
 *  personal SSH alias built by suffixing a real domain keeps the dot but
 *  fails the final-segment test. */
function looksLikeRealHostname(host: string): boolean {
  if (!host.includes('.')) return false
  const segments = host.split('.')
  return /^[a-zA-Z]+$/.test(segments[segments.length - 1] as string)
}

/**
 * Parse a git remote: the SSH shorthand (`git@host:owner/repo`) and the
 * http/https/ssh/git URL forms with optional userinfo and port, each with
 * an optional anchored `.git` suffix (repository names may contain dots).
 * The port is preserved only for http/https — SSH and git ports are not
 * usable for constructing web URLs.
 */
export function parseGitRemote(input: string): ParsedRepository | null {
  // Owner and name are each SINGLE path segments — the name capture must
  // not cross a slash, so a multi-segment remote path yields null. The
  // input is trimmed before matching.
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

/**
 * Parse a repository string: a URL parse filtered to the public host (a
 * non-public host returns null SILENTLY), else a bare `owner/name` form
 * (no scheme separator, no at-sign, exactly two non-empty parts). Only the
 * final fall-through logs a debug line.
 */
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

/**
 * Detect the repository for a directory (default: the working directory),
 * memoized per directory on positive parses only.
 */
export async function detectCurrentRepositoryWithHost(cwd?: string): Promise<ParsedRepository | null> {
  try {
    const directory = cwd ?? getCwd()
    const cached = repositoryCache.get(directory)
    if (cached) return cached

    let remoteUrl: string | null = null
    if (cwd === undefined) {
      // The shared helper is working-directory-implicit and repo-root
      // relative; with an explicit directory we skip straight past it.
      remoteUrl = await getRemoteUrl()
    }
    if (!remoteUrl) {
      // The direct config read is a fallback on BOTH paths.
      const result = await execFileNoThrowWithCwd(
        gitExe(),
        ['config', '--get', 'remote.origin.url'],
        { cwd: directory, preserveOutputOnError: false },
      )
      remoteUrl = result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
    }
    // Every log line naming a remote URL must be redacted — before the null
    // test, unconditionally.
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

/** `owner/name` only for the public host; consumers build public URLs. */
export async function detectCurrentRepository(): Promise<string | null> {
  const parsed = await detectCurrentRepositoryWithHost()
  if (!parsed || parsed.host !== PUBLIC_GIT_HOST) return null
  return `${parsed.owner}/${parsed.name}`
}

/** Synchronous cache read (public host only); the async functions populate it. */
export function getCachedRepository(): string | null {
  const cached = repositoryCache.get(getCwd())
  if (!cached || cached.host !== PUBLIC_GIT_HOST) return null
  return `${cached.owner}/${cached.name}`
}

/** Synchronous cache read of the host, for any host. */
export function getCachedRepositoryHost(): string | null {
  return repositoryCache.get(getCwd())?.host ?? null
}
