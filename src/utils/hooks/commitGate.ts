import type { SetAppState } from '../messageQueueManager.js'
import { getSessionId } from '../../bootstrap/state.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  isVerifySegment,
  pipefailActiveBefore,
  splitShellControlOps,
  stripQuotedShellArgs,
  verificationSummary,
} from '../verification/verificationState.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { findGitRoot } from '../git.js'
import { subprocessEnv } from '../subprocessEnv.js'
import {
  GENERATED_ASSETS_MAP,
  describeOwedAssets,
  generatedAssetsOwed,
  parseGeneratedAssetsMap,
  type GeneratedAssetRow,
} from './generatedAssets.js'


export const COMMIT_GATE_ID = 'commit-gate'


function isGitCommit(segment: string): boolean {
  return /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)))*\s+commit\b(?!-)/i.test(
    segment,
  )
}

function receiptEligibleCommand(segments: readonly { text: string }[]): boolean {
  return segments.every(s => {
    const head = s.text.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').toLowerCase()
    return head === 'git' || isVerifySegment(s.text)
  })
}

export interface CommitGateVerdict {
  allow: boolean
  rule:
    | 'not-a-commit'
    | 'chained-verify'
    | 'fresh-receipt'
    | 'bare-commit'
    | 'no-verify-flag'
  reason: string
}

export function evaluateCommitGate(
  command: string,
  opts?: {
    freshReceipt?: boolean
  },
): CommitGateVerdict {
  const cmd = typeof command === 'string' ? command : ''
  const segments = splitShellControlOps(cmd)
  const commitIdx = segments.findIndex(s => isGitCommit(s.text))
  if (commitIdx === -1) {
    return {
      allow: true,
      rule: 'not-a-commit',
      reason: 'no git commit in command',
    }
  }

  const commitSeg = segments[commitIdx]!
  if (hasNoVerifyFlag(commitSeg.text)) {
    return {
      allow: false,
      rule: 'no-verify-flag',
      reason:
        'git commit --no-verify skips the pre-commit safety hooks — denied. Run the verify, then commit without --no-verify.',
    }
  }

  if (commitSeg.opBefore === '&&') {
    for (let i = commitIdx - 1; i >= 0; i--) {
      if (isVerifySegment(segments[i]!.text)) {
        return {
          allow: true,
          rule: 'chained-verify',
          reason: 'commit is chained behind a verify (&&) — green-gate enforced',
        }
      }
      const op = segments[i]!.opBefore
      if (op === '&&') continue
      if (op === 'pipe' && pipefailActiveBefore(segments, i)) continue
      break
    }
  }

  if (opts?.freshReceipt) {
    return {
      allow: true,
      rule: 'fresh-receipt',
      reason:
        'fresh current-tree receipt: green verification evidence covers this exact tree with no mutations since — no same-command rerun required',
    }
  }

  return {
    allow: false,
    rule: 'bare-commit',
    reason:
      'unverified `git commit` — chain a verify with `&&` DIRECTLY before the commit (`&&` short-circuits on a failing verify; `;` `||` `&` run the commit regardless). To keep long verify output readable, prefix `set -o pipefail && verify | tail -40 && git commit …` — the pipeline then retains the verifier\'s exit status. A commit right after a green verify of the SAME tree passes without re-running (fresh receipt).',
  }
}

function hasNoVerifyFlag(segment: string): boolean {
  const bare = stripQuotedShellArgs(segment)
  if (/--no-verify\b/.test(bare)) return true
  return /(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(bare)
}

export const COMMIT_GATE_REPROMPT =
  'Commit gate: this commit is not verified. Three ways to satisfy it: ' +
  '(1) FRESH RECEIPT — a green verification of this EXACT tree with no edits since ' +
  'passes automatically (no rerun needed; if you just ran the suite green, commit plainly). ' +
  '(2) Chain your green-gate before the commit in the SAME command, e.g. ' +
  '`bun run build.ts && git commit -m "…"` — `&&` short-circuits, so a failing verify ' +
  'blocks the commit. `;` and `||` break that guarantee. ' +
  '(3) For long verify output, `set -o pipefail && verify 2>&1 | tail -40 && git commit -m "…"` ' +
  '— pipefail preserves the verifier\'s exit status, so the tail stays readable AND gated. ' +
  'A blocked chain never ran, so re-issue the WHOLE command including its `git add`. ' +
  'Do not use --no-verify. If this repo\'s verify runner is a custom script the gate ' +
  'doesn\'t recognize, set MERCURY_VERIFY_PATTERN to a regex that matches it.'

function generatedAssetsVerdict(command: string): true | string {
  try {
    const refusal = generatedAssetsRefusal(command, getCwd())
    return refusal === null ? true : refusal
  } catch (error) {
    return `Commit gate: the generated-asset rule could not read the commit (${error instanceof Error ? error.message : String(error)}) — commit again once git answers.`
  }
}

function commandFromContext(hookInput: unknown): string | null {
  if (
    hookInput == null ||
    typeof hookInput !== 'object' ||
    (hookInput as { hook_event_name?: string }).hook_event_name !== 'PreToolUse'
  ) {
    return null
  }
  const hi = hookInput as {
    tool_name?: string
    tool_input?: { command?: unknown }
  }
  if (hi.tool_name !== 'Bash' && hi.tool_name !== POWERSHELL_TOOL_NAME) return null
  const cmd = hi.tool_input?.command
  return typeof cmd === 'string' ? cmd : null
}

export function registerCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): string {
  return addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    `Bash|${POWERSHELL_TOOL_NAME}`,
    (_messages, _signal, context) => {
      if (flagEnv('MERCURY_COMMIT_GATE') === '0') return true
      if (!commitGateEnabled()) return true
      try {
        const command = commandFromContext(context?.hookInput)
        if (command === null) return true
        const shape = evaluateCommitGate(command)
        if (shape.allow) return generatedAssetsVerdict(command)
        if (shape.rule === 'no-verify-flag') return false
        let fresh = false
        try {
          if (receiptEligibleCommand(splitShellControlOps(command))) {
            const summary = verificationSummary(getCwd(), {})
            fresh =
              summary.state === 'verified' &&
              summary.lastEvidence !== null &&
              summary.lastEvidence.scope !== 'read-back'
          }
        } catch {
          fresh = false
        }
        if (!evaluateCommitGate(command, { freshReceipt: fresh }).allow) return false
        return generatedAssetsVerdict(command)
      } catch {
        return false
      }
    },
    COMMIT_GATE_REPROMPT,
    { timeout: 5000, id: COMMIT_GATE_ID },
  )
}


export function chainedSegmentsBeforeCommit(command: string): string[] {
  const segments = splitShellControlOps(command)
  const commitIdx = segments.findIndex(s => isGitCommit(s.text))
  if (commitIdx <= 0 || segments[commitIdx]!.opBefore !== '&&') return []
  const out: string[] = []
  for (let i = commitIdx - 1; i >= 0; i--) {
    out.push(segments[i]!.text.trim())
    const op = segments[i]!.opBefore
    if (op === '&&') continue
    if (op === 'pipe' && pipefailActiveBefore(segments, i)) continue
    break
  }
  return out
}

export function commitRepositoryRoot(commitSegment: string, cwd: string): string | null {
  const m = /\bgit\s+(?:(?:-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+))\s+)*-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(commitSegment)
  const dir = m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
  const start = dir === '' ? cwd : isAbsolute(dir) ? dir : resolve(cwd, dir)
  return findGitRoot(start)
}

function gitLines(root: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd: root, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000, windowsHide: true })
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

export function commitPathsOf(root: string, commitSegment: string): string[] {
  const paths = new Set(gitLines(root, ['diff', '--cached', '--name-only']))
  const bare = stripQuotedShellArgs(commitSegment)
  if (/(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/.test(bare)) {
    for (const p of gitLines(root, ['diff', '--name-only'])) paths.add(p)
  }
  return [...paths].sort()
}

export function loadGeneratedAssetsMap(root: string): { rows: GeneratedAssetRow[]; errors: string[] } | null {
  const path = join(root, GENERATED_ASSETS_MAP)
  if (!existsSync(path)) return null
  return parseGeneratedAssetsMap(readFileSync(path, 'utf8'))
}

export function generatedAssetsRefusal(command: string, cwd: string): string | null {
  const segments = splitShellControlOps(command)
  const commitSeg = segments.find(s => isGitCommit(s.text))
  if (commitSeg === undefined) return null
  const root = commitRepositoryRoot(commitSeg.text, cwd)
  if (root === null) return null
  const map = loadGeneratedAssetsMap(root)
  if (map === null) return null
  if (map.errors.length > 0) return `The generated-asset map (${GENERATED_ASSETS_MAP}) does not parse: ${map.errors.join('; ')} — fix the map before committing.`
  const commitPaths = commitPathsOf(root, commitSeg.text)
  if (commitPaths.length === 0) return null
  const staged = new Map<string, string | null>()
  const contentOf = (path: string): string | null => {
    if (staged.has(path)) return staged.get(path)!
    let text: string | null
    try {
      text = execFileSync('git', ['show', `:${path}`], { cwd: root, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    } catch {
      try {
        text = readFileSync(join(root, path), 'utf8')
      } catch {
        text = null
      }
    }
    if (text !== null && text.includes('\0')) text = null
    staged.set(path, text)
    return text
  }
  const readFile = (path: string): string | null => {
    try {
      return readFileSync(join(root, path), 'utf8')
    } catch {
      return null
    }
  }
  const owed = generatedAssetsOwed({ rows: map.rows, commitPaths, contentOf, readFile, chainedVerifies: chainedSegmentsBeforeCommit(command) })
  return owed.length === 0 ? null : describeOwedAssets(owed)
}

export function unregisterCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): void {
  removeFunctionHook(setAppState, sessionId, 'PreToolUse', COMMIT_GATE_ID)
}


export function commitGateEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_COMMIT_GATE'))
}

const commitGateEngagedSessions = new Set<string>()

export function isCommitGateEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return commitGateEngagedSessions.has(sessionId)
}

export function engageCommitGate(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!commitGateEnabled()) return false
  if (commitGateEngagedSessions.has(sessionId)) return false
  registerCommitGate(setAppState, sessionId)
  commitGateEngagedSessions.add(sessionId)
  logForDebugging(
    `[commit-gate] engaged for session ${sessionId}`,
  )
  return true
}

export function disengageCommitGate(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!commitGateEngagedSessions.has(sessionId)) return false
  unregisterCommitGate(setAppState, sessionId)
  commitGateEngagedSessions.delete(sessionId)
  logForDebugging(
    `[commit-gate] disengaged for session ${sessionId}`,
  )
  return true
}
