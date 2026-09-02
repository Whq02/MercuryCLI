// ============================================================================
//  services/eval — persistent eval kernels with tool re-entry (spec: the
//  parity-study eval axis). CONTRACTS: gates, key shapes, budgets, and the
//  availability vocabulary every other eval module builds on.
//
//  Laws in force here:
//  · Node is the runtime floor — kernels are CHILD NODE/PYTHON PROCESSES
//    (never a bun-only API, never a worker sharing the host's env by
//    accident); the dist must run them under `node dist/mercury.mjs`.
//  · The kernel obeys the session's PERMISSION MODE exactly as a direct tool
//    call does: re-entered tool calls ride the same
//    decision chain; flow-class modes never interrupt, ask-class modes ask,
//    and a pending ask pauses the cell budget.
//  · One cell per call, exclusive per owner; state persists per
//    (owner, language, normalized cwd, interpreter).
// ============================================================================

import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'

export type EvalLanguage = 'py' | 'js'

export const EVAL_LANGUAGES: readonly EvalLanguage[] = ['py', 'js']

/** The whole-axis gate (catalogue presence). */
export function evalEnabled(): boolean {
  return flagEnabled('MERCURY_EVAL')
}

/** Per-language sub-gates (define-falsy opt-out; both default on). */
export function evalLanguageEnabled(language: EvalLanguage): boolean {
  return language === 'py' ? flagEnabled('MERCURY_EVAL_PY') : flagEnabled('MERCURY_EVAL_JS')
}

/** The operator's explicit Python interpreter pin (ladder rung 1). */
export function evalPythonOverride(): string | undefined {
  const value = flagEnv('MERCURY_EVAL_PYTHON')?.trim()
  return value ? value : undefined
}

// ── Budgets (invariants are spec'd; the numbers are Mercury's own) ─────────

/** Default runtime budget for one cell, seconds. */
export const EVAL_DEFAULT_TIMEOUT_SECONDS = 30
/** Clamp ceiling for a caller-supplied nonzero timeout, seconds. */
export const EVAL_MAX_TIMEOUT_SECONDS = 600
/** Hard wall-clock ceiling for one Eval call — bounds bridge ping-pong
 *  livelock too. Pending PERMISSION decisions do not count against it (an
 *  operator-paced ask must never kill a cell); everything machine-paced
 *  does. */
export const EVAL_WALL_CEILING_MS = 30 * 60_000
/** How long after an interrupt the host waits for the runner's own
 *  cancelled `done` frame before killing and recreating the kernel. */
export const EVAL_INTERRUPT_ESCALATION_MS = 2_000
/** Polite-exit grace before SIGTERM, and SIGTERM grace before SIGKILL, at
 *  shutdown. */
export const EVAL_SHUTDOWN_GRACE_MS = 1_500
/** Idle wall before a retained kernel is reaped (box-civility: a parked
 *  interpreter holds RSS for nothing). Reaping is HONEST — the next cell on
 *  the key is annotated that state was reset, never a silent fresh kernel. */
export const EVAL_IDLE_TTL_MS = 15 * 60_000
/** Sweep cadence for the idle reaper. The interval is unref'd and alive only
 *  while kernels exist — an idle SESSION costs no timer at all. */
export const EVAL_IDLE_SWEEP_MS = 60_000

// ── Output bounds (the bounded sink) ───────────────────────────────────────

/** Model-visible head window per stream, bytes. */
export const EVAL_HEAD_BYTES = 24_000
/** Model-visible rolling tail per stream, bytes. */
export const EVAL_TAIL_BYTES = 8_000
/** Per-line column cap in model-visible text. */
export const EVAL_MAX_LINE_CHARS = 2_000
/** Per-display-value cap in model-visible text (full value in the spill). */
export const EVAL_MAX_DISPLAY_CHARS = 10_000
/** In-memory + on-disk spill ceiling for one cell's raw stream capture. */
export const EVAL_SPILL_MAX_BYTES = 8 * 1024 * 1024

// ── Cell request/result shapes ─────────────────────────────────────────────

export interface EvalCellInput {
  language: EvalLanguage
  code: string
  title?: string
  /** Seconds of RUNTIME work (bridge time excluded); 0 disables the runtime
   *  budget (the wall ceiling still stands); nonzero clamps to
   *  [1, EVAL_MAX_TIMEOUT_SECONDS]. */
  timeoutSeconds?: number
  /** Recreate THIS language's kernel before running (other languages keep
   *  their state). */
  reset?: boolean
}

/** One rich display emitted by a cell (MIME-keyed; standard types only —
 *  contract data). */
export interface EvalDisplay {
  mime: 'text/plain' | 'text/markdown' | 'application/json' | 'image/png' | 'image/jpeg'
  /** Text payload, or base64 when `b64` is set (images). */
  data: string
  b64?: boolean
}

export type EvalCellStatus = 'ok' | 'error' | 'cancelled'

export interface EvalStreamCapture {
  /** Model-visible bounded text (head + gap marker + tail). */
  text: string
  truncated: boolean
  totalBytes: number
  totalLines: number
}

export interface EvalCellOutcome {
  status: EvalCellStatus
  stdout: EvalStreamCapture
  stderr: EvalStreamCapture
  displays: EvalDisplay[]
  /** repr of the cell's final expression value, when the runner captured one. */
  resultRepr?: string
  error?: { name: string; value: string; traceback: string }
  /** Absolute path of the raw-stream spill artifact, when either stream
   *  truncated (the model can read the full bytes back). */
  spillPath?: string
  /** Honest annotations: kernel replaced/retried/killed, budget exhausted,
   *  interrupt escalated — never silent. */
  annotations: string[]
  /** Milliseconds of runtime actually burned (bridge time excluded). */
  runtimeMs: number
  /** Milliseconds spent inside bridge calls (tool re-entry, agents,
   *  completions — permission waits included). */
  bridgeMs: number
  executionCount: number
}

// ── Availability ───────────────────────────────────────────────────────────

export interface EvalLanguageAvailability {
  language: EvalLanguage
  available: boolean
  /** Interpreter/binary the kernel would spawn (absolute), when available. */
  interpreterPath?: string
  /** Version string when probed. */
  version?: string
  /** Why the language is unavailable or hidden (gate off, no binary,
   *  platform), when it is. */
  whyNot?: string
}

/** A typed refusal for a disabled/unavailable language — never a silent
 *  substitution (fixes the acknowledged upstream inconsistency: the live
 *  schema only ever advertises languages that would actually run). */
export function unavailableLanguageMessage(
  requested: string,
  alternatives: EvalLanguageAvailability[],
): string {
  const usable = alternatives.filter(a => a.available).map(a => a.language)
  const alt = usable.length > 0 ? ` Available: ${usable.join(', ')}.` : ' No eval language is currently available.'
  return `Eval language '${requested}' is not available in this session.${alt}`
}
