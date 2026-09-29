import { execFile, type ChildProcess } from 'node:child_process'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { projectReleases, type ChannelRelease } from './channelCore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const GH_TIMEOUT_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const MAX_GH_BYTES = 20 * 1024 * 1024
export const GH_DEADLINE_EXIT = 124
const GH_SPAWN_FAILED_EXIT = 127

const GH_DEADLINE_HOLDER = [
  "const { spawn } = require('node:child_process')",
  'const [ms, file, ...args] = process.argv.slice(1)',
  "const child = spawn(file, args, { stdio: 'inherit', windowsHide: true })",
  'let ended = false',
  "const end = code => { if (ended) return; ended = true; try { child.kill('SIGKILL') } catch {} process.exit(code) }",
  `const timer = setTimeout(() => end(${GH_DEADLINE_EXIT}), Number(ms))`,
  `child.on('error', e => { clearTimeout(timer); ended = true; process.stderr.write(String(e && e.code ? e.code : e) + '\\n'); process.exit(e && e.code === 'ENOENT' ? ${GH_SPAWN_FAILED_EXIT} : 1) })`,
  "child.on('exit', (code, signal) => { clearTimeout(timer); ended = true; process.exit(code === null ? 137 : code) })",
  "process.stdin.on('end', () => end(129))",
  "process.stdin.on('error', () => end(129))",
  'process.stdin.resume()',
  "process.on('SIGTERM', () => end(143))",
  "process.on('SIGHUP', () => end(129))",
  "process.on('SIGINT', () => end(130))",
].join('\n')

export function ghDeadlineMs(requested: number): number {
  const pinned = Number(flagEnv('MERCURY_GH_TIMEOUT_MS') ?? '')
  return Number.isFinite(pinned) && pinned > 0 ? Math.round(pinned) : requested
}

export function ghSpawnArgv(transport: string[], args: string[], deadlineMs: number): string[] {
  return [process.execPath, '-e', GH_DEADLINE_HOLDER, String(deadlineMs), ...transport, ...args]
}

const inFlight = new Set<ChildProcess>()
let cleanupArmed = false

function armInFlightCleanup(): void {
  if (cleanupArmed) return
  cleanupArmed = true
  registerCleanup(async () => {
    for (const child of inFlight) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  })
}

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
  const deadlineMs = ghDeadlineMs(opts.timeoutMs ?? GH_TIMEOUT_MS)
  const argv = ghSpawnArgv(ghArgv(), args, deadlineMs)
  const maxBuffer = opts.maxBuffer ?? MAX_GH_BYTES
  armInFlightCleanup()
  return new Promise(resolve => {
    const child = execFile(argv[0]!, argv.slice(1), { windowsHide: true, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), timeout: deadlineMs + 5_000, killSignal: 'SIGKILL', maxBuffer, env: { ...subprocessEnv() } }, (err, stdout, stderr) => {
      inFlight.delete(child)
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        const exitCode = typeof code === 'number' ? code : null
        const words = (stderr || '').trim()
        resolve({
          state: 'error',
          enoent: code === 'ENOENT' || (exitCode === GH_SPAWN_FAILED_EXIT && /^ENOENT$/m.test(words)),
          stderr: exitCode === GH_DEADLINE_EXIT ? `${words ? `${words}\n` : ''}gh did not answer within ${Math.round(deadlineMs / 1000)}s and was ended` : words || err.message || '',
        })
        return
      }
      resolve({ state: 'ok', stdout: stdout ?? '' })
    })
    inFlight.add(child)
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
