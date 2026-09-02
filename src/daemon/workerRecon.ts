// ============================================================================
//  workerRecon — the read-only recon allowlist every daemon-spawned worker
//  rides (the crew teammates, the one-shot runs).
//
//  Classifier-fault immunity for the read-only core: the auto-mode classifier
//  is an API dependency — a classifier fault (the empty-prompt 400, a real
//  outage, a 529 storm) denies EVERY un-ruled 'ask' in a headless seat.
//  Rule-ALLOWED calls short-circuit before the classifier, so this narrow,
//  strictly read-only recon set keeps a worker able to LOOK (inspect files,
//  query git, report evidence) under any classifier fault — while every
//  write/exec/network action still routes through the classifier.
//  Deliberately excluded: `find` (-delete flag), `git branch` (bare form
//  creates), anything that can mutate, execute repo content, or leave the
//  machine.
// ============================================================================
import { logForDebugging } from '../utils/debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export const SEAT_RECON_ALLOW: readonly string[] = [
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git blame:*)',
  'Bash(ls:*)',
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(wc:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(echo:*)',
  'Bash(pwd)',
  'Bash(which:*)',
]

/** A recon-allow entry must be a tool rule WITH a specifier — `Tool(...)` —
 *  never a bare tool name (a bare `Bash` grants everything) and never a
 *  standalone-wildcard specifier. Operator extensions ride the same bar. */
export function isValidReconAllowRule(rule: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*\([^()]{1,200}\)$/.test(rule)) return false
  const spec = rule.slice(rule.indexOf('(') + 1, -1).trim()
  return spec !== '*' && spec !== ':*' && spec.length > 0
}

/**
 * Resolve the daemon-worker recon allowlist. MERCURY_PARTY_RECON_ALLOW (the
 * env keeps its registered spelling — operator-facing):
 *   unset        ⇒ the builtin read-only set above
 *   '0'          ⇒ empty (kill the allowlist; every bash rides the classifier)
 *   'a,b,…' CSV  ⇒ builtin + the VALID extra rules (invalid entries dropped
 *                  loudly — never silently widened, never fail-open to bare
 *                  tool grants)
 * One recon concept for every daemon-spawned worker, not a per-team env.
 */
export function resolveWorkerReconAllow(): readonly string[] {
  const raw = (flagEnv('MERCURY_PARTY_RECON_ALLOW') ?? '').trim()
  if (!raw) return SEAT_RECON_ALLOW
  if (raw === '0') return []
  const extras: string[] = []
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (isValidReconAllowRule(part)) {
      extras.push(part)
    } else {
      logForDebugging(
        `[daemon] MERCURY_PARTY_RECON_ALLOW entry ${JSON.stringify(part)} is not a Tool(specifier) rule — dropped (bare tool names and wildcard specifiers are refused)`,
      )
    }
  }
  return [...SEAT_RECON_ALLOW, ...extras]
}
