/**
 * Shell-agnostic detection of git / pull-request operations from a command
 * string plus its combined output. The collapsed transcript summary names
 * what happened (a commit and its short sha, a PR and its number, the count
 * of plain commands) — and because git/gh/glab/curl are external binaries
 * with identical argv syntax on every shell, matching the raw command text
 * behaves the same for Bash and PowerShell.
 *
 * The command is ALWAYS consulted first: a sha or a PR URL that merely
 * appears in unrelated output (a `git log` listing, a pasted link) must
 * never be reported as an operation.
 */

import type { UUID } from 'node:crypto'

export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction = 'created' | 'edited' | 'merged' | 'commented' | 'closed' | 'ready'

export type GitOperationDetection = {
  commit?: { sha: string; kind: CommitKind }
  push?: { branch: string }
  branch?: { ref: string; action: BranchAction }
  pr?: { number: number; url?: string; action: PrAction }
}

// ── command matching ────────────────────────────────────────────────────────

/**
 * git's global options may sit between `git` and the subcommand — repeated
 * `-c <value>`, `-C <value>` and `--key=value` forms are all tolerated
 * (contract data: the retry-with-a-signing-option shape after a signing
 * failure is `git -c commit.gpgsign=false commit …`).
 */
const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:-c\s+\S+|-C\s+\S+|--[\w-]+=\S+)\s+)*`

function gitSubcommandPattern(subcommand: string): RegExp {
  return new RegExp(String.raw`(?:^|[\s;&|(])git\s+${GIT_GLOBAL_OPTIONS}${subcommand}(?![\w-])`)
}

const COMMIT_COMMAND = gitSubcommandPattern('commit')
const PUSH_COMMAND = gitSubcommandPattern('push')
const CHERRY_PICK_COMMAND = gitSubcommandPattern('cherry-pick')
// `merge` must not match a following hyphen so merge-base and friends stay out.
const MERGE_COMMAND = gitSubcommandPattern('merge')
const REBASE_COMMAND = gitSubcommandPattern('rebase')

/** `gh pr <verb>` forms, first match in this order wins (contract data). */
const PR_COMMANDS: ReadonlyArray<{ pattern: RegExp; action: PrAction }> = [
  { pattern: /\bgh\s+pr\s+create\b/, action: 'created' },
  { pattern: /\bgh\s+pr\s+edit\b/, action: 'edited' },
  { pattern: /\bgh\s+pr\s+merge\b/, action: 'merged' },
  { pattern: /\bgh\s+pr\s+comment\b/, action: 'commented' },
  { pattern: /\bgh\s+pr\s+close\b/, action: 'closed' },
  { pattern: /\bgh\s+pr\s+ready\b/, action: 'ready' },
]

// ── output matching ─────────────────────────────────────────────────────────

/**
 * git's bracketed commit summary: `[<branch> <sha>]` or
 * `[<branch> (root-commit) <sha>]` (contract data). The branch token accepts
 * word characters, dots, slashes and hyphens; the sha is lowercase hex.
 */
const COMMIT_SUMMARY_LINE = /\[[\w./-]+(?:\s+\(root-commit\))?\s+([0-9a-f]+)\]/

/**
 * git's push ref-update line (contract data): an optional status flag
 * character, then `[new branch]` or an `old..new` / `old...new` range, the
 * source ref, an arrow, and the destination ref — which is the branch.
 *
 * The range tokens are bounded ({1,256} — far beyond any real ref) because
 * the two greedy runs overlap the dot literal: unbounded, a single
 * pathological whitespace-free line makes the scan quadratic in the full
 * output cap, a multi-second stall. Bounded, the worst case is constant per
 * line and a longer-than-real token simply doesn't read as a ref update.
 */
const PUSH_REF_UPDATE_LINE =
  /^\s*[+\-*!=]?\s*(?:\[new branch\]|\S{1,256}\.{2,3}\S{1,256})\s+\S+\s+->\s+(\S+)/m

const FAST_FORWARD_OR_MERGE_MADE = /Fast-forward|Merge made by/
const SUCCESSFUL_REBASE = /Successfully rebased/

/** A GitHub pull-request URL anywhere in the output (contract data). */
const GITHUB_PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

/**
 * The bare confirmation shape merge/close/ready print when no URL is shown:
 * "pull request" (either capitalisation), an optional `owner/repo#` prefix,
 * an optional bare `#`, then the digits.
 */
const PULL_REQUEST_PHRASE = /[Pp]ull request\s+(?:[\w.-]+\/[\w.-]+)?#?(\d+)/

/** GitLab merge-request creation (contract data; recognition retained, no effect). */
const GLAB_MR_CREATE = /\bglab\s+mr\s+create\b/

/**
 * A curl command that (a) is a POST — explicit `-X POST` / `--request POST`
 * (case-insensitive, optional `=`) or an implicit POST inferred from a
 * space-delimited `-d` data flag — AND (b) targets an http(s) `…/pulls`,
 * `…/pull-requests`, `…/merge_requests` or `…/merge-requests` endpoint that
 * is not followed by `/<digits>` (so a comments sub-resource is excluded).
 * The scheme prefix keeps the pattern from matching text inside a POST body.
 * Recognition only: nothing consumes a positive match today.
 */
const CURL_COMMAND = /\bcurl\b/
const CURL_EXPLICIT_POST = /(?:-X|--request)[\s=]+POST\b/i
const CURL_IMPLICIT_POST_DATA = /\s-d\s/
const CURL_PR_ENDPOINT = /https?:\/\/\S*?\/(?:pulls|pull-requests|merge_requests|merge-requests)(?!\/\d)/i

function isCurlPrCreate(command: string): boolean {
  if (!CURL_COMMAND.test(command)) return false
  const isPost = CURL_EXPLICIT_POST.test(command) || CURL_IMPLICIT_POST_DATA.test(command)
  return isPost && CURL_PR_ENDPOINT.test(command)
}

/**
 * The first non-flag token after the subcommand, stopping at any token that
 * begins with a shell operator character.
 */
function refAfterSubcommand(command: string, subcommand: string): string | undefined {
  const match = new RegExp(String.raw`git\s+${GIT_GLOBAL_OPTIONS}${subcommand}(?![\w-])(.*)$`, 's').exec(command)
  if (!match) return undefined
  for (const token of (match[1] ?? '').trim().split(/\s+/)) {
    if (token.length === 0) continue
    if (/^[&|;><]/.test(token)) return undefined
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/** The short (6-character) sha from git's bracketed summary line, or undefined. */
export function parseGitCommitId(stdout: string): string | undefined {
  const match = COMMIT_SUMMARY_LINE.exec(stdout)
  return match ? match[1]!.slice(0, 6) : undefined
}

function prActionFor(command: string): PrAction | undefined {
  for (const entry of PR_COMMANDS) {
    if (entry.pattern.test(command)) return entry.action
  }
  return undefined
}

/**
 * Detect the git operations a command performed, from the command text and
 * the concatenated stdout+stderr (git push writes its ref update to stderr).
 */
export function detectGitOperation(command: string, output: string): GitOperationDetection {
  const result: GitOperationDetection = {}

  const isCherryPick = CHERRY_PICK_COMMAND.test(command)
  if (isCherryPick || COMMIT_COMMAND.test(command)) {
    const sha = parseGitCommitId(output)
    if (sha !== undefined) {
      const kind: CommitKind = isCherryPick
        ? 'cherry-picked'
        : /\s--amend\b/.test(command)
          ? 'amended'
          : 'committed'
      result.commit = { sha, kind }
    }
  }

  if (PUSH_COMMAND.test(command)) {
    const match = PUSH_REF_UPDATE_LINE.exec(output)
    if (match) result.push = { branch: match[1]! }
  }

  // Both checks run in sequence over the same slot: a command satisfying
  // both reports `rebased`.
  if (MERGE_COMMAND.test(command) && FAST_FORWARD_OR_MERGE_MADE.test(output)) {
    const ref = refAfterSubcommand(command, 'merge')
    if (ref !== undefined) result.branch = { ref, action: 'merged' }
  }
  if (REBASE_COMMAND.test(command) && SUCCESSFUL_REBASE.test(output)) {
    const ref = refAfterSubcommand(command, 'rebase')
    if (ref !== undefined) result.branch = { ref, action: 'rebased' }
  }

  const prAction = prActionFor(command)
  if (prAction !== undefined) {
    const urlMatch = GITHUB_PULL_URL.exec(output)
    if (urlMatch) {
      result.pr = { number: Number(urlMatch[2]), url: urlMatch[0], action: prAction }
    } else {
      const phrase = PULL_REQUEST_PHRASE.exec(output)
      if (phrase) result.pr = { number: Number(phrase[1]), action: prAction }
    }
  }

  return result
}

/**
 * Session/PR linking — the one live effect of this entry point. A non-zero
 * exit code is a no-op. On success, when the command created a PR and stdout
 * carries a PR URL, the current session is linked to that PR through the
 * session-storage service. Both the storage module and the session-id
 * accessor are imported dynamically (an import cycle otherwise), and the
 * whole path is fire-and-forget. The other recognitions (GitLab MR creation,
 * curl-based PR creation) are computed and deliberately have no effect —
 * their telemetry sinks are deliberately absent.
 */
export function trackGitOperations(command: string, exitCode: number, stdout?: string): void {
  if (exitCode !== 0) return
  void GLAB_MR_CREATE.test(command)
  void isCurlPrCreate(command)
  if (prActionFor(command) !== 'created') return
  const urlMatch = GITHUB_PULL_URL.exec(stdout ?? '')
  if (!urlMatch) return
  const repository = urlMatch[1]!
  const number = Number(urlMatch[2])
  const url = urlMatch[0]
  void (async () => {
    try {
      const [{ linkSessionToPR }, { getSessionId }] = await Promise.all([
        import('../../utils/sessionStorage.js'),
        import('../../bootstrap/state.js'),
      ])
      await linkSessionToPR(String(getSessionId()) as UUID, number, url, repository)
    } catch {
      // Linking is best-effort bookkeeping; a failure never surfaces.
    }
  })()
}
