
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


const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:-c\s+\S+|-C\s+\S+|--[\w-]+=\S+)\s+)*`

function gitSubcommandPattern(subcommand: string): RegExp {
  return new RegExp(String.raw`(?:^|[\s;&|(])git\s+${GIT_GLOBAL_OPTIONS}${subcommand}(?![\w-])`)
}

const COMMIT_COMMAND = gitSubcommandPattern('commit')
const PUSH_COMMAND = gitSubcommandPattern('push')
const CHERRY_PICK_COMMAND = gitSubcommandPattern('cherry-pick')
const MERGE_COMMAND = gitSubcommandPattern('merge')
const REBASE_COMMAND = gitSubcommandPattern('rebase')

const PR_COMMANDS: ReadonlyArray<{ pattern: RegExp; action: PrAction }> = [
  { pattern: /\bgh\s+pr\s+create\b/, action: 'created' },
  { pattern: /\bgh\s+pr\s+edit\b/, action: 'edited' },
  { pattern: /\bgh\s+pr\s+merge\b/, action: 'merged' },
  { pattern: /\bgh\s+pr\s+comment\b/, action: 'commented' },
  { pattern: /\bgh\s+pr\s+close\b/, action: 'closed' },
  { pattern: /\bgh\s+pr\s+ready\b/, action: 'ready' },
]


const COMMIT_SUMMARY_LINE = /\[[\w./-]+(?:\s+\(root-commit\))?\s+([0-9a-f]+)\]/

const PUSH_REF_UPDATE_LINE =
  /^\s*[+\-*!=]?\s*(?:\[new branch\]|\S{1,256}\.{2,3}\S{1,256})\s+\S+\s+->\s+(\S+)/m

const FAST_FORWARD_OR_MERGE_MADE = /Fast-forward|Merge made by/
const SUCCESSFUL_REBASE = /Successfully rebased/

const GITHUB_PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

const PULL_REQUEST_PHRASE = /[Pp]ull request\s+(?:[\w.-]+\/[\w.-]+)?#?(\d+)/

const GLAB_MR_CREATE = /\bglab\s+mr\s+create\b/

const CURL_COMMAND = /\bcurl\b/
const CURL_EXPLICIT_POST = /(?:-X|--request)[\s=]+POST\b/i
const CURL_IMPLICIT_POST_DATA = /\s-d\s/
const CURL_PR_ENDPOINT = /https?:\/\/\S*?\/(?:pulls|pull-requests|merge_requests|merge-requests)(?!\/\d)/i

function isCurlPrCreate(command: string): boolean {
  if (!CURL_COMMAND.test(command)) return false
  const isPost = CURL_EXPLICIT_POST.test(command) || CURL_IMPLICIT_POST_DATA.test(command)
  return isPost && CURL_PR_ENDPOINT.test(command)
}

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
    }
  })()
}
