// ============================================================================
//  progressModel — the typed progress/attempt vocabulary for the run kernel
//
//
//  An ATTEMPT is a normalized description of what one tool call tried:
//  tool family · normalized target · expected evidence class · a digest of
//  the SALIENT input. Equality is digest equality — never prose equality —
//  so superficial diffs (descriptions, labels, key order, whitespace) never
//  mint novelty, while a genuinely different action (other path, other
//  content, other command) always does. Whether a REPEATED attempt is
//  legitimate is not decided here: the kernel folds repeats against eligible
//  progress (a changed prerequisite IS progress, which re-arms repetition),
//  and the continuation authority (2.2) consumes the folded state.
//
//  PROGRESS is derived exclusively from real events the kernel already
//  receives — succeeded effects with persisted artifact deltas, verification
//  results, task-state transitions, lifecycle moves. Model self-claims are
//  representable only as the attempt's purpose field (an underivable
//  hypothesis label) and never count as progress.
//
//  Zero IO, zero config, zero React — node:crypto/path only; proof scripts
//  drive everything directly.
// ============================================================================

import { createHash } from 'node:crypto'
import * as path from 'node:path'

/** What evidence class an attempt is expected to produce. */
export type EvidenceClass =
  | 'artifact-delta' // file mutations that persist
  | 'execution' // shell/process runs (evidence = exit + effects)
  | 'observation' // reads/searches — digest-receipted so repeats are visible
  | 'delegation' // subagent/task fan-out
  | 'verification' // explicit test/verify invocations
  | 'interaction' // operator-facing asks

export interface AttemptFingerprint {
  /** Normalized tool family — never the raw tool name. */
  toolFamily: string
  /** Normalized primary target: cwd-relative posix path, command head, or ''. */
  normalizedTarget: string
  /** The model-declared hypothesis/purpose when one rode the call — the ONE
   *  self-claimed field (underivable); '' otherwise. Never part of the key. */
  purpose: string
  expectedEvidenceClass: EvidenceClass
  /** sha256[0:16] of the canonicalized SALIENT input. */
  inputDigest: string
}

const MUTATING_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ChangeSet'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const OBSERVE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ProviderSearch'])
const DELEGATE_TOOLS = new Set(['Task', 'Agent', 'Workflow', 'LaunchFleet'])
const VERIFY_HEADS = new Set(['test', 'pytest', 'jest', 'vitest', 'typecheck', 'tsc', 'verify'])

/** The family a tool name belongs to (stable across renames of instances). */
export function toolFamilyOf(toolName: string): { family: string; evidence: EvidenceClass } {
  if (MUTATING_FILE_TOOLS.has(toolName)) return { family: 'mutate:file', evidence: 'artifact-delta' }
  if (SHELL_TOOLS.has(toolName)) return { family: 'execute:shell', evidence: 'execution' }
  if (OBSERVE_TOOLS.has(toolName)) return { family: 'observe', evidence: 'observation' }
  if (DELEGATE_TOOLS.has(toolName)) return { family: 'delegate', evidence: 'delegation' }
  if (toolName === 'AskUserQuestion') return { family: 'interact', evidence: 'interaction' }
  return { family: `tool:${toolName.toLowerCase()}`, evidence: 'observation' }
}

/** Posix-normalize a path; make it cwd-relative when it lives under cwd. */
function normalizeTargetPath(p: string, cwd: string): string {
  const posix = p.replaceAll('\\', '/')
  const posixCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  const abs = posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)
  if (abs && posixCwd && posix.toLowerCase().startsWith(posixCwd.toLowerCase() + '/')) {
    return posix.slice(posixCwd.length + 1)
  }
  return path.posix.normalize(posix)
}

/** The leading command token of a shell string, quotes/env-prefix stripped —
 *  the fingerprint's OWN small law (the evidence classifier's richer grammar
 *  stays owned by verificationState; this one only names the head). */
export function commandHead(command: string): string {
  const stripped = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '')
  const first = stripped.split(/\s+/)[0] ?? ''
  const unquoted = first.replace(/^["']|["']$/g, '')
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted
  return base.toLowerCase()
}

/** Normalize shell text for digesting: collapse whitespace, drop comments. */
function canonicalShellText(command: string): string {
  return command
    .replace(/(^|\s)#[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * Mint the fingerprint for one tool call. The SALIENT input per family:
 *   mutate:file — target path + content/patch bytes (a changed description
 *     or reordered sibling key never changes the digest; changed bytes do);
 *   execute:shell — the canonicalized command text;
 *   observe — target (path/pattern/url) + salient query;
 *   everything else — the target + a stable JSON of the input MINUS volatile
 *     presentation keys (description/label/title).
 */
export function makeAttemptFingerprint(args: {
  toolName: string
  input: unknown
  cwd: string
  purpose?: string
}): AttemptFingerprint {
  const { family, evidence } = toolFamilyOf(args.toolName)
  const input = (args.input ?? {}) as Record<string, unknown>
  const rawPath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : typeof input.path === 'string'
          ? input.path
          : undefined

  let normalizedTarget = ''
  let inputDigest = ''
  let evidenceClass = evidence

  if (family === 'execute:shell') {
    const command = typeof input.command === 'string' ? input.command : ''
    normalizedTarget = commandHead(command)
    inputDigest = digest(['shell', canonicalShellText(command)])
    if (VERIFY_HEADS.has(normalizedTarget)) evidenceClass = 'verification'
  } else if (family === 'mutate:file') {
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : ''
    const bytes =
      typeof input.content === 'string'
        ? input.content
        : typeof input.new_string === 'string'
          ? `${String(input.old_string ?? '')}\u0001${input.new_string}`
          : stableSalientJson(input)
    inputDigest = digest(['mutate', normalizedTarget, bytes])
  } else if (family === 'observe') {
    const query =
      typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.url === 'string'
          ? input.url
          : typeof input.query === 'string'
            ? input.query
            : ''
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : query
    inputDigest = digest(['observe', normalizedTarget, query, String(input.offset ?? ''), String(input.limit ?? '')])
  } else {
    normalizedTarget = rawPath ? normalizeTargetPath(rawPath, args.cwd) : ''
    inputDigest = digest([family, normalizedTarget, stableSalientJson(input)])
  }

  return {
    toolFamily: family,
    normalizedTarget,
    purpose: args.purpose ?? '',
    expectedEvidenceClass: evidenceClass,
    inputDigest,
  }
}

/** Presentation-only keys that never affect attempt identity. */
const VOLATILE_KEYS = new Set(['description', 'label', 'title', 'activeForm'])

function stableSalientJson(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
    .filter(k => !VOLATILE_KEYS.has(k))
    .sort()
  return JSON.stringify(keys.map(k => [k, input[k]]))
}

/** The ledger identity of a fingerprint (purpose deliberately excluded). */
export function fingerprintKey(fp: AttemptFingerprint): string {
  return `${fp.toolFamily}\u0000${fp.normalizedTarget}\u0000${fp.inputDigest}`
}

/** A next-action's ADMISSION fingerprint (A04-A06): digest of the case/
 *  whitespace-normalized text — prose equality is exactly what admission
 *  must not depend on, so the digest rides the normalized form. */
export function actionFingerprint(nextAction: string): string {
  return digest(['action', nextAction.toLowerCase().replace(/\s+/g, ' ').trim()])
}

// ── the folded progress state (lives on RunSnapshot.progress) ───────────────

export type ProgressPhase =
  | 'productive'
  | 'stagnant'
  | 'replan-required'
  | 'handoff-required'
  | 'terminal'

export interface AttemptLedgerRow {
  key: string
  family: string
  target: string
  count: number
  /** Repeats of this key with NO eligible progress in between. */
  barrenRepeats: number
  lastAt: number
}

export interface RunProgressState {
  phase: ProgressPhase
  /** Eligible progress events since the last stop decision. */
  progressSinceDecision: number
  totalProgress: number
  /** Attempts since the last eligible progress event. */
  attemptsSinceProgress: number
  /** Attempts since progress whose fingerprint was already in the ledger. */
  repeatAttemptsSinceProgress: number
  replansUsed: number
  attempts: AttemptLedgerRow[]
  totalAttempts: number
  lastEligibleProgress: { kind: string; detail: string; at: number } | null
}

export const MAX_ATTEMPT_LEDGER = 64

/** Phase thresholds — exported so the 2.2 continuation authority and the
 *  provers consume the SAME numbers (S2: stagnation settles by the second
 *  no-progress continuation; one replan max). */
export const STAGNANT_AFTER_BARREN_ATTEMPTS = 4
// S3/C3: the SECOND identical failure (the first barren REPEAT) already
// demands a strategy change — 1, not 2 (corrected at 2.3 when the cycle
// guard adopted the law's own wording).
export const REPLAN_AFTER_BARREN_REPEATS = 1
export const HANDOFF_AFTER_REPLANS = 1

export function emptyProgressState(): RunProgressState {
  return {
    phase: 'productive',
    progressSinceDecision: 0,
    totalProgress: 0,
    attemptsSinceProgress: 0,
    repeatAttemptsSinceProgress: 0,
    replansUsed: 0,
    attempts: [],
    totalAttempts: 0,
    lastEligibleProgress: null,
  }
}

/** Pure phase derivation from the folded counters (+ lifecycle terminality,
 *  which the kernel passes in so this module never learns lifecycle). */
export function deriveProgressPhase(
  s: Omit<RunProgressState, 'phase'>,
  terminalLifecycle: boolean,
): ProgressPhase {
  if (terminalLifecycle) return 'terminal'
  if (s.repeatAttemptsSinceProgress >= REPLAN_AFTER_BARREN_REPEATS) {
    return s.replansUsed >= HANDOFF_AFTER_REPLANS ? 'handoff-required' : 'replan-required'
  }
  if (s.attemptsSinceProgress >= STAGNANT_AFTER_BARREN_ATTEMPTS) return 'stagnant'
  return 'productive'
}

// ── the pure folds the kernel routes events through ─────────────────────────

function rephase(s: Omit<RunProgressState, 'phase'>, terminal: boolean): RunProgressState {
  return { ...s, phase: deriveProgressPhase(s, terminal) }
}

/** One ATTEMPT observed (at tool settlement). A repeat is a fingerprint the
 *  ledger has seen with no eligible progress since its last occurrence —
 *  the folded barrenRepeats carries exactly that (progress resets it). */
export function foldAttempt(
  prev: RunProgressState,
  fp: AttemptFingerprint,
  at: number,
  terminalLifecycle: boolean,
): RunProgressState {
  const key = fingerprintKey(fp)
  const existing = prev.attempts.find(r => r.key === key)
  const isBarrenRepeat = existing !== undefined && existingSeenSinceProgress(existing, prev)
  const row: AttemptLedgerRow = existing
    ? {
        ...existing,
        count: existing.count + 1,
        barrenRepeats: isBarrenRepeat ? existing.barrenRepeats + 1 : existing.barrenRepeats,
        lastAt: at,
      }
    : {
        key,
        family: fp.toolFamily,
        target: fp.normalizedTarget,
        count: 1,
        barrenRepeats: 0,
        lastAt: at,
      }
  const others = prev.attempts.filter(r => r.key !== key)
  const attempts = [...others, row]
    .sort((a, b) => a.lastAt - b.lastAt)
    .slice(-MAX_ATTEMPT_LEDGER)
  return rephase(
    {
      ...prev,
      attempts,
      totalAttempts: prev.totalAttempts + 1,
      attemptsSinceProgress: prev.attemptsSinceProgress + 1,
      repeatAttemptsSinceProgress: isBarrenRepeat
        ? prev.repeatAttemptsSinceProgress + 1
        : prev.repeatAttemptsSinceProgress,
    },
    terminalLifecycle,
  )
}

/** A repeat is barren only if NO eligible progress landed after the key's
 *  last occurrence — progress stamps lastEligibleProgress; comparing times
 *  keeps the judgment pure (a changed prerequisite IS progress and re-arms
 *  legitimate retries by resetting this comparison). */
function existingSeenSinceProgress(row: AttemptLedgerRow, s: RunProgressState): boolean {
  return s.lastEligibleProgress === null || row.lastAt >= s.lastEligibleProgress.at
}

/** Eligible progress derived from a REAL event (artifact delta that
 *  persisted, verification result, task-state transition). Never a model
 *  self-claim. Resets the barren counters — legitimately re-arming retries. */
export function foldEligibleProgress(
  prev: RunProgressState,
  kind: 'artifact-delta' | 'verification' | 'task-state' | 'prerequisite-change',
  detail: string,
  at: number,
  terminalLifecycle: boolean,
): RunProgressState {
  return rephase(
    {
      ...prev,
      progressSinceDecision: prev.progressSinceDecision + 1,
      totalProgress: prev.totalProgress + 1,
      attemptsSinceProgress: 0,
      repeatAttemptsSinceProgress: 0,
      lastEligibleProgress: { kind, detail, at },
    },
    terminalLifecycle,
  )
}

/** A stop decision closes the since-decision window; a replan decision
 *  consumes the one replan allowance (S2: one replan max before handoff). */
export function foldStopDecision(
  prev: RunProgressState,
  decision: string,
  terminalLifecycle: boolean,
): RunProgressState {
  return rephase(
    {
      ...prev,
      progressSinceDecision: 0,
      replansUsed: /replan/i.test(decision) ? prev.replansUsed + 1 : prev.replansUsed,
    },
    terminalLifecycle,
  )
}

/** Lifecycle went terminal — the phase machine parks. */
export function foldTerminalProgress(prev: RunProgressState): RunProgressState {
  return { ...prev, phase: 'terminal' }
}
