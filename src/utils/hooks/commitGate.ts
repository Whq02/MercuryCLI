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

// ============================================================================
//  utils/hooks/commitGate.ts — the &&-gated commit gate (MERCURY_COMMIT_GATE):
//  the pure verdict, the PreToolUse hook, and its per-session engager.
//
//  The Mercury doctrine *requests* "verify-then-checkpoint every batch — commit
//  only on green, chained `tests && commit`". A prompt can only request it. This
//  PreToolUse(Bash) hook ENFORCES it: a bare `git commit` is DENIED before it
//  runs unless the commit is chained behind a verify in the SAME command via
//  `&&`. Because `&&` short-circuits, a failing build/test never reaches the
//  commit — so unverified work mechanically cannot ship. A `--no-verify` commit
//  (which skips git's own pre-commit hooks) is denied outright.
//
//  SAFETY-POSITIVE: the gate only ever ADDS a verification requirement to a
//  state-changing action. It never bypasses any permission/approval/capability
//  gate, and it is scoped to git-commit Bash commands — every other command and
//  tool passes straight through.
//
//  GATED DEFAULT-OFF: opt in with MERCURY_COMMIT_GATE=1. OFF ⇒ never engaged ⇒
//  byte-identical (a default session installs no commit gate). Engaged from the
//  session-start path in QueryEngine and from the REPL mount.
// ============================================================================

/** Hook id so engage/disengage can remove exactly this hook. */
export const COMMIT_GATE_ID = 'commit-gate'

// The verify vocabulary is OWNED by verificationState: ONE recognizer
// decides both "does this command mint evidence" and "does this segment
// satisfy the gate". The old parallel VERIFY_PATTERNS list is absent — the AVS
// field run proved the split (`npm run validate` + `npm test` satisfied THIS
// gate's list while minting nothing in the evidence model, so the stop gate
// simultaneously called the same work unverified). `isVerifySegment` carries
// the whole vocabulary: Mercury-canonical shapes, the generic npm/pytest/
// cargo/make families (verbs test|build|typecheck|lint|check|validate|verify|
// ci), the no-op-head guard, quoted-arg blanking, and the
// MERCURY_VERIFY_PATTERN project escape.

/** Does this segment invoke `git commit` (vs. e.g. `git commit-graph`, `--amend` is fine)?
 *  Tolerates the pre-verb global options (`git -C <dir> commit`, `git -c k=v
 *  commit`, `--git-dir/--work-tree`) — the bare `git commit` pattern let every
 *  multi-repo `-C` commit bypass the gate entirely (wave finding 6). */
function isGitCommit(segment: string): boolean {
  return /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)))*\s+commit\b(?!-)/i.test(
    segment,
  )
}

/** Fresh-receipt eligibility (wave findings 1+5): the receipt attests the
 *  PRE-command tree, so it may vouch only for commands that cannot CHANGE
 *  the tree before committing — every segment must be git-headed or itself a
 *  verify. `sed -i … && git commit` / `echo x > f; git commit` must never
 *  ride a receipt into an unverified commit. */
function receiptEligibleCommand(segments: readonly { text: string }[]): boolean {
  return segments.every(s => {
    const head = s.text.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').toLowerCase()
    return head === 'git' || isVerifySegment(s.text)
  })
}

export interface CommitGateVerdict {
  /** Whether the command is allowed to proceed. */
  allow: boolean
  /** How the verdict was reached. */
  rule:
    | 'not-a-commit'
    | 'chained-verify'
    | 'fresh-receipt'
    | 'bare-commit'
    | 'no-verify-flag'
  /** Human-readable reason (shown to the model on a deny). */
  reason: string
}

/**
 * Evaluate the &&-gate for a Bash command. Pure + exported for the proof harness.
 * A commit is allowed ONLY when it is reached through an unbroken `&&` chain
 * whose left side contains a real verify, so a failing verify short-circuits
 * before the commit. Rules, in order:
 *  - no `git commit` anywhere                  → allow (not our concern)
 *  - the commit carries `--no-verify`          → DENY (bypasses git's safety hooks)
 *  - a verify is &&-chained directly before the commit, with NO `;`/`||`/`&`
 *    breaking that specific chain — a `|` boundary inside the chain counts as
 *    UNBROKEN only under an earlier `set -o pipefail` (the pipeline then
 *    retains the verifier's exit status, so `verify | tail -20 && git commit`
 *    keeps the short-circuit guarantee AND a readable tail; item 2 — the
 *    old pure-`&&` law forced 181.5 KB of unpiped validator output that hid
 *    the commit result)                         → allow
 *  - the caller attests a FRESH CURRENT-TREE receipt (opts.freshReceipt: green
 *    evidence covering this exact tree with zero mutations since — the hook
 *    reads verificationState, never the command shape) → allow
 *  - otherwise                                  → DENY
 */
export function evaluateCommitGate(
  command: string,
  opts?: {
    /** Live receipt attestation from verificationState (hook-computed):
     *  state === 'verified' — newest evidence green, digest-bound to the
     *  CURRENT tree, no mutations since. Never derived from the command. */
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

  // The commit is guarded only by the CONTIGUOUS guard-run ending at it: `&&`
  // boundaries always guard; a `pipe` boundary guards ONLY under an earlier
  // `set -o pipefail` (exit status preserved). Walk left while the run is
  // unbroken, looking for a verify. A break (`;` `||` `&`), or a pipe without
  // pipefail, means the commit can run without the verify having succeeded.
  if (commitSeg.opBefore === '&&') {
    for (let i = commitIdx - 1; i >= 0; i--) {
      if (isVerifySegment(segments[i]!.text)) {
        return {
          allow: true,
          rule: 'chained-verify',
          reason: 'commit is chained behind a verify (&&) — green-gate enforced',
        }
      }
      // Can the guard-run extend past this segment's LEFT boundary?
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

/**
 * Whether this commit segment carries a verify-skip flag. Scoped to the FLAG
 * region: the quoted `-m`/`-F` message is blanked first (so `git commit -m
 * "handle the -n flag"` is NOT a no-verify commit), then we match `--no-verify`
 * or a short-flag CLUSTER containing `n` (covers `-n`, `-nm`, `-vnm`; excludes
 * `-m`/`-am`/`-F`, which have no `n`).
 */
function hasNoVerifyFlag(segment: string): boolean {
  const bare = stripQuotedShellArgs(segment)
  if (/--no-verify\b/.test(bare)) return true
  return /(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(bare)
}

/** The static deny message the hook surfaces (covers both deny rules). */
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

/** Pull the shell command out of a PreToolUse hook input, or null. Handles BOTH
 *  the Bash tool and the Windows PowerShell tool (both expose `tool_input.command`)
 *  — the gate was Bash-only, so a `git commit` via the PowerShell tool bypassed it
 *  entirely on Windows. */
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

/**
 * Install the commit gate as a PreToolUse(Bash|PowerShell) function hook — both
 * shells can run `git commit`, and on Windows commits go via the PowerShell tool
 * The callback reads the EXACT pending command from the hook-input
 * context (not the transcript), so batched calls are gated individually.
 * Non-shell / non-commit calls pass.
 */
export function registerCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): string {
  return addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    `Bash|${POWERSHELL_TOOL_NAME}`, // Bash AND the Windows PowerShell tool (HB-0130)
    (_messages, _signal, context) => {
      // Live re-check: the hook installs ONCE, but honors the gate LIVE —
      // commitGateEnabled() (MERCURY_COMMIT_GATE / the /authority toggle) is
      // re-read on every call so an OFF flip actually stops gating instead of
      // the stale hook denying commits until session end.
      //
      // EXPLICIT hard-off wins: the block message
      // advertises "Set MERCURY_COMMIT_GATE=0 to disable" — isEnvTruthy treats
      // '0' and unset identically, so the opt-out is checked first.
      if (flagEnv('MERCURY_COMMIT_GATE') === '0') return true
      if (!commitGateEnabled()) return true
      // Fail-CLOSED: executeFunctionHook catches a thrown callback and lets the tool
      // PROCEED (non_blocking_error). For a safety gate that would silently ship an
      // unverified commit on an unexpected parse error, so deny (false) on any throw
      // — mirrors the dispatch gate's defensiveness but errs toward blocking.
      try {
        const command = commandFromContext(context?.hookInput)
        if (command === null) return true // not a Bash command we can read → pass
        const shape = evaluateCommitGate(command)
        if (shape.allow) return true
        if (shape.rule === 'no-verify-flag') return false
        // Shape would deny — consult the LIVE receipt before denying (
        // item 2): green evidence digest-bound to the CURRENT tree with no
        // mutations since means the work IS verified; forcing a same-command
        // rerun to satisfy command SHAPE is the AVS field friction (40s
        // validate + full suite re-run, then 181.5 KB of unpiped output).
        // Receipt probe failure ⇒ no receipt (fall through to deny) — the
        // gate itself stays fail-closed. Wave hardening:
        //  · the COMMAND must be receipt-eligible (git/verify segments only —
        //    a mutation inside the command would outrun the receipt, TOCTOU);
        //  · a read-back settlement row is STOP-gate evidence, never a COMMIT
        //    receipt — in a foreign-runner repo a red `./gradlew check` mints
        //    nothing, so "I re-read my edits" must not green-light a commit.
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
        return evaluateCommitGate(command, { freshReceipt: fresh }).allow
      } catch {
        return false
      }
    },
    COMMIT_GATE_REPROMPT,
    { timeout: 5000, id: COMMIT_GATE_ID },
  )
}

/** Remove the commit gate for a session. */
export function unregisterCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): void {
  removeFunctionHook(setAppState, sessionId, 'PreToolUse', COMMIT_GATE_ID)
}

// ── the per-session engager ──────────────────────────────────────────────────
// PER-SESSION engage guards: a
// module-global boolean was PROCESS-global, but hooks are stored PER sessionId
// (sessionHooks Map). Once one session engaged, every LATER session id in the
// same process (/clear → regenerateSessionId, /resume switchSession, SDK
// multi-conversation, daemon headless turns) hit the early return and never
// registered its own hook. Keyed by sessionId so each new session id re-arms.

/** Is the commit gate enabled for this build/session? DEFAULT-OFF. */
export function commitGateEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_COMMIT_GATE'))
}

const commitGateEngagedSessions = new Set<string>()

/** Whether the commit gate is currently engaged this session. */
export function isCommitGateEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return commitGateEngagedSessions.has(sessionId)
}

/**
 * Engage the commit gate (PreToolUse Bash) for a session. No-op (returns
 * false) when the env gate is off or when it is already engaged. Returns true
 * only when it actually installed the gate.
 */
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

/** Remove the commit gate. No-op unless THIS module engaged it. */
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
