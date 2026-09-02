// ============================================================================
//  src/services/privateChannel/ghRelease.ts — the gh-CLI transport for the
//  private release channel.
//
//  The collaborator's OWN signed-in GitHub CLI is the only credential path
//  (the repository law: never npm, never a public bucket, never an anonymous
//  endpoint, never a parallel login store). Every call here is a read against
//  the ONE configured private repository; nothing prints, copies or persists
//  GitHub access material — gh holds its own credentials and we never ask it
//  for a token.
//
//  Unavailability is EXACT (the repoHost pattern): gh missing / not signed
//  in / no repository access are distinct, each with its remedy.
// ============================================================================
import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { repoSlugFromUrl, type ChannelRelease } from './channelCore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const GH_TIMEOUT_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const MAX_GH_BYTES = 20 * 1024 * 1024

export type GhAccess =
  | { state: 'ok' }
  | { state: 'gh-missing'; note: string; remedy: string }
  | { state: 'not-signed-in'; note: string; remedy: string }
  | { state: 'no-repo-access'; note: string; remedy: string }

export type GhResult = { state: 'ok'; stdout: string } | { state: 'error'; enoent: boolean; stderr: string }

/** The channel repository slug: the packaged repository URL is the root;
 *  MERCURY_UPDATE_CHANNEL_REPO is the hermetic proof seam (read through the
 *  flag registry, D9). */
export function channelRepoSlug(): string {
  const pinned = flagEnv('MERCURY_UPDATE_CHANNEL_REPO')
  if (pinned) return pinned
  return repoSlugFromUrl(MACRO.PACKAGE_URL) ?? 'Whq02/PreRelease'
}

/** The gh transport argv: the real CLI, unless MERCURY_GH_CMD pins a JSON
 *  argv prefix (the Windows-capable hermetic proof seam — win32 execFile
 *  cannot spawn .cmd/.bat shims, so PATH-fronting a fake gh script is not
 *  portable; a `["node","…/fake-gh.mjs"]` prefix is). Read LIVE per call;
 *  malformed values fall back to the real gh. */
function ghArgv(): string[] {
  const pinned = flagEnv('MERCURY_GH_CMD')
  if (pinned) {
    try {
      const parsed: unknown = JSON.parse(pinned)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => typeof x === 'string')) {
        return parsed as string[]
      }
    } catch {
      // fall through to the real gh
    }
  }
  return ['gh']
}

function gh(args: string[], timeoutMs = GH_TIMEOUT_MS): Promise<GhResult> {
  const argv = ghArgv()
  return new Promise(resolve => {
    execFile(argv[0]!, [...argv.slice(1), ...args], { windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_GH_BYTES, env: { ...subprocessEnv() } }, (err, stdout, stderr) => {
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

/** Exact access triage for the configured private repository. */
export async function checkAccess(slug: string): Promise<GhAccess> {
  const auth = await gh(['auth', 'status'])
  if (auth.state === 'error') {
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
      remedy: 'run `gh auth login` with the GitHub account that has access to the private Mercury repository',
    }
  }
  const repo = await gh(['api', `repos/${slug}`, '--jq', '.private'])
  if (repo.state === 'error') {
    return {
      state: 'no-repo-access',
      note: `your GitHub account cannot see ${slug} (private repository)`,
      remedy: 'ask the repository owner for a collaborator invitation, accept it, then retry',
    }
  }
  return { state: 'ok' }
}

interface RawRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name?: string }>
}

export type ReleaseListResult =
  | { state: 'ok'; releases: ChannelRelease[] }
  | { state: 'unavailable'; note: string; remedy: string }

/** List the private repository's releases (drafts included so the core can
 *  ignore them by rule, not by accident). */
export async function listReleases(slug: string): Promise<ReleaseListResult> {
  const res = await gh(['api', `repos/${slug}/releases?per_page=50`])
  if (res.state === 'error') {
    return {
      state: 'unavailable',
      note: `could not list releases for ${slug}: ${res.stderr.slice(0, 200)}`,
      remedy: 'check `gh auth status` and your access to the private repository',
    }
  }
  try {
    const raw = JSON.parse(res.stdout) as RawRelease[]
    if (!Array.isArray(raw)) throw new Error('not an array')
    const releases: ChannelRelease[] = raw.map(r => ({
      tagName: r.tag_name ?? '',
      isDraft: r.draft === true,
      isPrerelease: r.prerelease === true,
      assetNames: (r.assets ?? []).map(a => a.name ?? '').filter(Boolean),
    }))
    return { state: 'ok', releases }
  } catch {
    return {
      state: 'unavailable',
      note: 'gh returned unparseable release data',
      remedy: 'upgrade gh or retry',
    }
  }
}

export type DownloadResult = { state: 'ok' } | { state: 'failed'; note: string; remedy: string }

/** Download exactly the named assets of one release into `destDir`. */
export async function downloadReleaseAssets(
  slug: string,
  tag: string,
  assetNames: string[],
  destDir: string,
): Promise<DownloadResult> {
  const args = ['release', 'download', tag, '--repo', slug, '--dir', destDir]
  for (const name of assetNames) args.push('--pattern', name)
  const res = await gh(args, DOWNLOAD_TIMEOUT_MS)
  if (res.state === 'error') {
    return {
      state: 'failed',
      note: `download of ${assetNames.join(' + ')} from ${tag} failed: ${res.stderr.slice(0, 200)}`,
      remedy: 'check your network and `gh auth status`, then rerun `mercury update` — nothing was activated',
    }
  }
  return { state: 'ok' }
}
