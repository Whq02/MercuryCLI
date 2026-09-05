import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { projectReleases, type ChannelRelease } from './channelCore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const GH_TIMEOUT_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const MAX_GH_BYTES = 20 * 1024 * 1024

export type GhSignIn =
  | { state: 'ok' }
  | { state: 'gh-missing'; note: string; remedy: string }
  | { state: 'not-signed-in'; note: string; remedy: string }

export type GhRepoAccess = { state: 'ok' } | { state: 'no-repo-access'; note: string; remedy: string }

export type GhResult = { state: 'ok'; stdout: string } | { state: 'error'; enoent: boolean; stderr: string }

export function ghArgv(): string[] {
  const pinned = flagEnv('MERCURY_GH_CMD')
  if (pinned) {
    try {
      const parsed: unknown = JSON.parse(pinned)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => typeof x === 'string')) {
        return parsed as string[]
      }
    } catch {
    }
  }
  return ['gh']
}

export interface GhSpawnOptions {
  timeoutMs?: number
  cwd?: string
  maxBuffer?: number
}

export function gh(args: string[], opts: GhSpawnOptions = {}): Promise<GhResult> {
  const argv = ghArgv()
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS
  const maxBuffer = opts.maxBuffer ?? MAX_GH_BYTES
  return new Promise(resolve => {
    execFile(argv[0]!, [...argv.slice(1), ...args], { windowsHide: true, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, env: { ...subprocessEnv() } }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          state: 'error',
          enoent: (err as NodeJS.ErrnoException).code === 'ENOENT',
          stderr: (stderr || err.message || '').trim(),
        })
        return
      }
      resolve({ state: 'ok', stdout: stdout ?? '' })
    })
  })
}

export async function ghSignIn(): Promise<GhSignIn> {
  const auth = await gh(['auth', 'status'])
  if (auth.state === 'ok') return { state: 'ok' }
  if (auth.enoent) {
    return {
      state: 'gh-missing',
      note: 'the GitHub CLI (gh) is not installed or not on PATH',
      remedy: 'install it from https://cli.github.com and run `gh auth login`',
    }
  }
  return {
    state: 'not-signed-in',
    note: 'gh is installed but not signed in',
    remedy: 'run `gh auth login`',
  }
}

export async function ghRepoAccess(slug: string): Promise<GhRepoAccess> {
  const repo = await gh(['api', `repos/${slug}`, '--jq', '.private'])
  if (repo.state === 'error') {
    return {
      state: 'no-repo-access',
      note: `your GitHub account cannot see ${slug}`,
      remedy: 'a private channel needs a collaborator invitation — ask the repository owner, accept it, then retry; a public one should answer, so check `gh auth status` and your network',
    }
  }
  return { state: 'ok' }
}

export type ReleaseListResult =
  | { state: 'ok'; releases: ChannelRelease[] }
  | { state: 'unavailable'; note: string; remedy: string }

export async function listReleases(slug: string): Promise<ReleaseListResult> {
  const res = await gh(['api', `repos/${slug}/releases?per_page=50`])
  if (res.state === 'error') {
    return {
      state: 'unavailable',
      note: `could not list releases for ${slug}: ${res.stderr.slice(0, 200)}`,
      remedy: 'check `gh auth status` and your access to the repository',
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(res.stdout)
  } catch {
    raw = undefined
  }
  const releases = projectReleases(raw)
  if (releases === null) {
    return {
      state: 'unavailable',
      note: 'gh returned unparseable release data',
      remedy: 'upgrade gh or retry',
    }
  }
  return { state: 'ok', releases }
}

export type DownloadResult = { state: 'ok' } | { state: 'failed'; note: string; remedy: string }

export async function downloadReleaseAssets(
  slug: string,
  tag: string,
  assetNames: string[],
  destDir: string,
): Promise<DownloadResult> {
  const args = ['release', 'download', tag, '--repo', slug, '--dir', destDir]
  for (const name of assetNames) args.push('--pattern', name)
  const res = await gh(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
  if (res.state === 'error') {
    return {
      state: 'failed',
      note: `download of ${assetNames.join(' + ')} from ${tag} failed: ${res.stderr.slice(0, 200)}`,
      remedy: 'check your network and `gh auth status`, then rerun `mercury update` — nothing was activated',
    }
  }
  return { state: 'ok' }
}
