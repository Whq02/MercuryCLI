import type { UUID } from 'node:crypto'

export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction = 'created' | 'edited' | 'merged' | 'commented' | 'closed' | 'ready'

type GitOperationDetection = {
  commit?: { sha: string; kind: CommitKind }
  push?: { branch: string }
  branch?: { ref: string; action: BranchAction }
  pr?: { number: number; url?: string; action: PrAction }
}


const GIT_GLOBAL_OPTIONS = String.raw`(?:(?:-c\s+\S+|-C\s+\S+|--[\w-]+=\S+)\s+)*`

function gitSubcommandPattern(subcommand: string): RegExp {
  return new RegExp(String.raw`(?:^|[\s;&|(])git\s+${GIT_GLOBAL_OPTIONS}${subcommand}(?![\w-])`)
}

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

function parseGitCommitId(stdout: string): string | undefined {
  const match = COMMIT_SUMMARY_LINE.exec(stdout)
  return match ? match[1]!.slice(0, 6) : undefined
}

function prActionFor(command: string): PrAction | undefined {
  for (const entry of PR_COMMANDS) {
    if (entry.pattern.test(command)) return entry.action
  }
  return undefined
}

const GIT_COMMIT_COMMAND = gitSubcommandPattern('commit')
const GIT_CHERRY_PICK_COMMAND = gitSubcommandPattern('cherry-pick')
const GIT_PUSH_COMMAND = gitSubcommandPattern('push')
const GIT_MERGE_COMMAND = gitSubcommandPattern('merge')
const GIT_REBASE_COMMAND = gitSubcommandPattern('rebase')

export function detectGitOperation(command: string, output: string): GitOperationDetection {
  const detection: GitOperationDetection = {}

  const isCherryPick = GIT_CHERRY_PICK_COMMAND.test(command)
  const isCommit = !isCherryPick && GIT_COMMIT_COMMAND.test(command)
  if (isCherryPick || isCommit) {
    const sha = parseGitCommitId(output)
    if (sha !== undefined) {
      const kind: CommitKind = isCherryPick
        ? 'cherry-picked'
        : /(?:^|\s)--amend(?![\w-])/.test(command)
          ? 'amended'
          : 'committed'
      detection.commit = { sha, kind }
    }
  }

  if (GIT_PUSH_COMMAND.test(command)) {
    const pushMatch = PUSH_REF_UPDATE_LINE.exec(output)
    if (pushMatch && pushMatch[1]) {
      detection.push = { branch: pushMatch[1] }
    }
  }

  if (GIT_MERGE_COMMAND.test(command) && FAST_FORWARD_OR_MERGE_MADE.test(output)) {
    const ref = refAfterSubcommand(command, 'merge')
    if (ref !== undefined) {
      detection.branch = { ref, action: 'merged' }
    }
  } else if (GIT_REBASE_COMMAND.test(command) && SUCCESSFUL_REBASE.test(output)) {
    const ref = refAfterSubcommand(command, 'rebase')
    if (ref !== undefined) {
      detection.branch = { ref, action: 'rebased' }
    }
  }

  const prAction = prActionFor(command)
  if (prAction !== undefined) {
    const urlMatch = GITHUB_PULL_URL.exec(output)
    if (urlMatch) {
      detection.pr = {
        number: Number(urlMatch[2]),
        url: urlMatch[0],
        action: prAction,
      }
    } else {
      const phraseMatch = PULL_REQUEST_PHRASE.exec(output)
      if (phraseMatch) {
        detection.pr = {
          number: Number(phraseMatch[1]),
          action: prAction,
        }
      }
    }
  }

  return detection
}

export async function trackGitOperations(command: string, exitCode: number, stdout?: string): Promise<string | undefined> {
  if (exitCode !== 0) return undefined
  void GLAB_MR_CREATE.test(command)
  void isCurlPrCreate(command)
  if (prActionFor(command) !== 'created') return undefined
  const urlMatch = GITHUB_PULL_URL.exec(stdout ?? '')
  if (!urlMatch) return undefined
  const repository = urlMatch[1]!
  const number = Number(urlMatch[2])
  const url = urlMatch[0]
  try {
    const [{ linkSessionToPR }, { getSessionId }] = await Promise.all([
      import('../../utils/sessionStorage.js'),
      import('../../bootstrap/state.js'),
    ])
    await linkSessionToPR(String(getSessionId()) as UUID, number, url, repository)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const { logError } = await import('../../utils/log.js')
    logError(new Error(`the session could not be recorded against pull request ${url}, so it is not listed with it: ${message}`))
    return `the pull request link could not be saved (${message}), so this session will not show it`
  }
}
