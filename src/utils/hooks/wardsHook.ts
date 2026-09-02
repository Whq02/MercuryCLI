// ============================================================================
//  Wards hook — MERCURY_WARDS registration at the PreToolUse seam.
//
//  Arms the deterministic content-rule wards (src/utils/wards/wards.ts) for a
//  session: builtin Mercury hard rules + project rules from .mercury/wards.json.
//  A violating Edit/Write/NotebookEdit/Bash/PowerShell call is DENIED with a
//  teaching re-prompt (the dynamic-string FunctionHook path — the same proven
//  plumbing as the fable tool-efficiency gate). Zero standing prompt bytes:
//  the rules inject only on violation.
//
//  Posture (deliberate, per rule class):
//   · HARD-RULE semantics — repeat violations are re-denied (unlike the
//     efficiency gate's deny-once); the law is the law.
//   · Session cap (WARD_DENIAL_CAP) — the never-wedge floor: a pathological
//     loop eventually passes, and the pass is visible in debug logs.
//   · FAIL-OPEN on any internal surprise — a broken ward must never break a
//     session (the same posture as the ledger gates it descends from).
//
//  Gate: MERCURY_WARDS (registry 'default-on' — default-ON, `=0` kills).
//  OFF ⇒ registerWardsHook returns null, no hook exists, PreToolUse is
//  byte-identical default. Proof: scripts/wards/prove-wards.ts.
// ============================================================================

import { resolveProjectConfigPath } from '../projectConfig.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enqueueNotification } from '../../context/notifications.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import {
  AUTONOMOUS_WARDS,
  BUILTIN_WARDS,
  WARDS_TOOL_MATCHER,
  buildWardDenial,
  evaluateWards,
  parseProjectWardsWithReport,
  type PendingToolCall,
  type WardRule,
} from '../wards/wards.js'
import { addFunctionHook } from './sessionHooks.js'

/** Fixed id: re-registration replaces-by-identity. */
export const WARDS_HOOK_ID = 'wards-content-rules'

/** Never-wedge floor: after this many denials the wards stand down (logged). */
const WARD_DENIAL_CAP = 25

export function wardsEnabled(): boolean {
  return flagEnabled('MERCURY_WARDS')
}

/**
 * The autonomous delete-ward rides ONLY spawned sessions: MERCURY_SPAWNED_BY is
 * stamped by every spawn chokepoint
 * and never set in an operator-driven session. MERCURY_DELETE_WARD=0 kills it.
 * Boot-time decision by design — the stamp is set before the child boots and
 * never changes mid-session.
 */
export function deleteWardActive(): boolean {
  return (
    flagEnv('MERCURY_SPAWNED_BY') !== undefined &&
    flagEnv('MERCURY_DELETE_WARD') !== '0'
  )
}

/** Load project rules from <cwd>/.mercury/wards.json WITH the parse report
 *  (resolveProjectConfigPath; absent ⇒ none, no problems). A PRESENT file
 *  that cannot serve its rules is a problem, not a silent nothing (FC-143),
 *  and its LOSS is one line for the notification channel (C7 disclosure:
 *  zero-or-fewer safety rules must never be silent). */
export function loadProjectWardsWithReport(cwd: string): {
  rules: WardRule[]
  problems: string[]
  loss?: string
  path?: string
} {
  let wardsPath: string | undefined
  try {
    wardsPath = resolveProjectConfigPath(cwd, 'wards.json') ?? undefined
    if (!wardsPath) return { rules: [], problems: [] }
    const text = readFileSync(wardsPath, 'utf-8')
    return { ...parseProjectWardsWithReport(text), path: wardsPath }
  } catch (error) {
    const why = error instanceof Error ? error.message.slice(0, 80) : String(error)
    return {
      rules: [],
      problems: [`wards.json exists but cannot be read (${why}) — every project ward is inactive`],
      loss: `unreadable (${why}) — its safety rules are OFF`,
      ...(wardsPath !== undefined ? { path: wardsPath } : {}),
    }
  }
}

/** The rules alone (provers and the dual-config oracle read this shape). */
export function loadProjectWards(cwd: string): WardRule[] {
  return loadProjectWardsWithReport(cwd).rules
}

// Per-session engage guard (the forcedReadHook contract).
const wardsEngagedSessions = new Set<string>()

/** TEST-ONLY: reset the per-session guard so proofs can re-register. */
export function resetWardsEngagedSessionsForTest(): void {
  wardsEngagedSessions.clear()
}

/**
 * Register the wards PreToolUse hook for a session. Self-gating: returns null
 * (and registers nothing) unless MERCURY_WARDS resolves enabled on a fork
 * build. Idempotent per session. Returns the hook id when armed.
 */
export function registerWardsHook(
  setAppState: SetAppState,
  sessionId: string,
): string | null {
  if (!wardsEnabled()) return null
  if (wardsEngagedSessions.has(sessionId)) return WARDS_HOOK_ID
  const projectReport = loadProjectWardsWithReport(getCwd())
  // Every parse problem reaches the debug log at registration; doctor's wards
  // row carries them loudly (FC-143 — a dropped ward must be reported
  // somewhere).
  for (const problem of projectReport.problems) {
    logForDebugging(`wards: ${problem}`)
  }
  if (projectReport.loss !== undefined) {
    // C7 disclosure: a wards-file LOSS means fewer (or zero) safety rules
    // this session — one line on the real notification channel, never a
    // debug-log half. Print mode queues harmlessly (no notification surface).
    enqueueNotification(setAppState, {
      key: 'wards-file',
      text: `project wards file ${projectReport.path ?? 'wards.json'}: ${projectReport.loss} this session`,
      priority: 'high',
      color: 'warning',
      timeoutMs: 30_000,
    })
  }
  const rules: WardRule[] = [
    ...BUILTIN_WARDS,
    ...(deleteWardActive() ? AUTONOMOUS_WARDS : []),
    ...projectReport.rules,
  ]
  let denials = 0
  addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    WARDS_TOOL_MATCHER,
    (_messages, _signal, context) => {
      // Live re-read (authority-toggles rule): the kill honors mid-session.
      if (!wardsEnabled()) return true
      if (denials >= WARD_DENIAL_CAP) return true // never-wedge floor
      try {
        const hookInput = context?.hookInput as
          | { tool_name?: unknown; tool_input?: unknown }
          | undefined
        if (!hookInput || typeof hookInput.tool_name !== 'string') return true
        const pending: PendingToolCall = {
          toolName: hookInput.tool_name,
          input:
            hookInput.tool_input && typeof hookInput.tool_input === 'object'
              ? (hookInput.tool_input as Record<string, unknown>)
              : {},
        }
        const verdict = evaluateWards(rules, pending)
        if (verdict.allow) return true
        denials++
        if (denials === WARD_DENIAL_CAP) {
          logForDebugging(
            `wards: denial cap (${WARD_DENIAL_CAP}) reached for session ${sessionId} — standing down`,
          )
        }
        return buildWardDenial(verdict, pending.toolName)
      } catch {
        return true // fail-open: a broken ward never breaks the session
      }
    },
    // Static fallback (the dynamic string above is the normal path).
    `Ward blocked this tool call: it violates a mechanical content rule ` +
      `(see .mercury/wards.json + the builtin Mercury hard rules). Rewrite the ` +
      `call to comply.`,
    { timeout: 5000, id: WARDS_HOOK_ID },
  )
  wardsEngagedSessions.add(sessionId)
  return WARDS_HOOK_ID
}
