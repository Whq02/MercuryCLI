import { gh } from '../privateChannel/ghRelease.js'
import { repoSlugFromUrl } from '../privateChannel/channelCore.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

const AUTH_TIMEOUT_MS = 15_000
const VIEW_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 60_000

const PUBLIC_HOME_SLUG = 'Whq02/MercuryCLI'

const SLUG_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function issueRepoSlug(): string {
  const configured = (flagEnv('MERCURY_ISSUES_REPO_URL') ?? '').trim()
  if (configured !== '') {
    if (SLUG_SHAPE.test(configured)) return configured
    const fromUrl = repoSlugFromUrl(configured)
    if (fromUrl !== null) return fromUrl
  }
  const packaged = typeof MACRO !== 'undefined' && typeof MACRO.PACKAGE_URL === 'string' ? MACRO.PACKAGE_URL : ''
  return repoSlugFromUrl(packaged) ?? PUBLIC_HOME_SLUG
}

export function issuesPageUrl(slug: string): string {
  return `https://github.com/${slug}/issues`
}

export type IssueAccess =
  | { state: 'ok' }
  | { state: 'gh-missing'; note: string; remedy: string }
  | { state: 'not-signed-in'; note: string; remedy: string }
  | { state: 'no-repo-access'; note: string; remedy: string }

export async function checkIssueAccess(slug: string): Promise<IssueAccess> {
  const auth = await gh(['auth', 'status'], { timeoutMs: AUTH_TIMEOUT_MS })
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
      remedy: 'run `gh auth login`',
    }
  }
  const repo = await gh(['repo', 'view', slug, '--json', 'name'], { timeoutMs: VIEW_TIMEOUT_MS })
  if (repo.state === 'error') {
    return {
      state: 'no-repo-access',
      note: `your GitHub account cannot see ${slug}`,
      remedy: 'check the repository name (MERCURY_ISSUES_REPO_URL when set) and your network, then retry',
    }
  }
  return { state: 'ok' }
}

export type FileIssueResult =
  | { state: 'filed'; url: string }
  | { state: 'failed'; note: string; remedy: string }

export function fileIssueArgv(i: { slug: string; title: string; bodyFile: string }): string[] {
  return ['issue', 'create', '--repo', i.slug, '--title', i.title, '--body-file', i.bodyFile]
}

const ISSUE_URL = /https?:\/\/\S+\/issues\/\d+/

export async function fileIssue(i: { slug: string; title: string; bodyFile: string }): Promise<FileIssueResult> {
  const res = await gh(fileIssueArgv(i), { timeoutMs: CREATE_TIMEOUT_MS })
  if (res.state === 'error') {
    return {
      state: 'failed',
      note: res.enoent
        ? 'the GitHub CLI (gh) is not installed or not on PATH'
        : `gh issue create failed: ${res.stderr.slice(0, 300) || 'no output'}`,
      remedy: `check \`gh auth status\`, then retry — or paste the body by hand at ${issuesPageUrl(i.slug)}`,
    }
  }
  const url = ISSUE_URL.exec(res.stdout)?.[0]
  if (url === undefined) {
    return {
      state: 'failed',
      note: `gh printed no issue URL: ${res.stdout.trim().slice(0, 200) || 'no output'}`,
      remedy: `check \`gh issue list --repo ${i.slug}\` — the issue may exist; otherwise paste the body by hand at ${issuesPageUrl(i.slug)}`,
    }
  }
  return { state: 'filed', url }
}
