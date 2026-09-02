// ============================================================================
//  permissionBypassBridge — the READ-SIDE of the sovereign posture (the
//  operator's tool-permission-prompt bypass; the in-UI parity of
//  --dangerously-skip-permissions).
//
//  Two signals feed it: the LIVE in-process permission mode
//  (toolPermissionContext.mode === 'sovereign' — the REAL prompt bypass in
//  this REPL) and the harness flag file (harness/sovereign.json,
//  { enabled, ts }) the harness UI writes and this module only READS.
//  Framework-agnostic (no React, no DOM):
//
//    • readSovereignFlag()  — the file read: harness/sovereign.json relative
//                             to the cwd, default OFF when absent/malformed
//                             (the safe default — prompts stay ON). A missing
//                             source is a STATE, not a crash.
//    • bypassSnapshot()     — the honest Snapshot<{ bypassOn, lastChanged,
//                             via }> the surface renders from. Either source
//                             active ⇒ bypassed.
//    • bypassAge(ts)        — the compact "last changed" age label.
//
//  SAFETY: the bypass covers the tool-PERMISSION PROMPT only. It does NOT
//  loosen the spawn allowlist or any other safety-locked control; it is
//  OPT-IN (default OFF) and, via the banner, always VISIBLE when on. FAIL
//  SAFE: any read error resolves to OFF so the UI never implies a bypass
//  that is not in effect.
// ============================================================================

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from './cwd.js'
import { withState, type Snapshot } from './cockpit/types.js'

/** The harness bypass flag, as carried by harness/sovereign.json. */
export interface SovereignFlag {
  enabled: boolean
  /** ISO timestamp of the last toggle, when the flag file carried one. */
  ts?: string
}

/** The honest bridge payload the surface renders from. `bypassOn` is the
 *  union of the harness flag and the live in-process bypass mode; `lastChanged`
 *  is the harness flag's ISO ts when present; `via` names which signal lit it. */
export interface BypassData {
  bypassOn: boolean
  /** ISO timestamp of the last harness-flag toggle, when known. */
  lastChanged?: string
  /** Which signal made it ON: the live in-process mode, the harness flag, or both. */
  via: 'mode' | 'flag' | 'mode+flag' | 'none'
}

export type BypassSnapshot = Snapshot<{ data: BypassData }>

/** Read the operator's bypass flag from the harness file (the same source the
 *  harness dev API serves READ-ONLY). Resolves to { enabled:false } when the
 *  file is absent or malformed so the UI fails safe (bypass OFF, permission
 *  prompts active) rather than implying a bypass that is not actually in
 *  effect. The write side is NOT here — the toggle is harness UI only. Never
 *  throws. */
export function readSovereignFlag(): SovereignFlag {
  try {
    const path = join(getCwd(), 'harness', 'sovereign.json')
    if (!existsSync(path)) return { enabled: false }
    const raw = readFileSync(path, { encoding: 'utf8' })
    const parsed = JSON.parse(raw) as { enabled?: unknown; ts?: unknown }
    return {
      enabled: parsed.enabled === true,
      ...(typeof parsed.ts === 'string' ? { ts: parsed.ts } : {}),
    }
  } catch {
    return { enabled: false }
  }
}

/** Compact "last changed" age label for the flag's ts. */
export function bypassAge(ts: string | undefined): string {
  if (!ts) return ''
  const ms = Date.now() - Date.parse(ts)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const s = Math.round(ms / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** The honest bypass bridge. Combines:
 *   - `bypassMode`: the LIVE in-process permission mode (passed in from the
 *     command's app state — toolPermissionContext.mode). 'sovereign' is
 *     the REAL prompt bypass active in THIS REPL right now.
 *   - the harness flag file (the operator/coord toggle, read fresh each call).
 *  Either being active ⇒ bypassed. State is `blocked` when bypassed (a safety
 *  gate is open — crimson), `off` when prompts are active (the safe default).
 *  Never throws — a read failure resolves to OFF. */
export function bypassSnapshot(opts?: { bypassMode?: string }): BypassSnapshot {
  try {
    // Bypass-posture modes (sovereign|autopilot) — prompts are being
    // auto-allowed under either, so the honesty surface shows BLOCKED for both.
    const liveMode =
      opts?.bypassMode === 'sovereign' || opts?.bypassMode === 'autopilot'
    const flag = readSovereignFlag()
    const enabled = liveMode || flag.enabled
    const via: BypassData['via'] =
      liveMode && flag.enabled ? 'mode+flag' : liveMode ? 'mode' : flag.enabled ? 'flag' : 'none'
    return {
      // `blocked` = a safety gate is OPEN (crimson spine); `off` = the safe default.
      state: enabled ? 'blocked' : 'off',
      source: 'toolPermissionContext + harness/sovereign.json',
      reason: enabled
        ? 'tool-permission prompts are being auto-allowed'
        : 'permission prompts active (safe default)',
      data: {
        bypassOn: enabled,
        ...(flag.ts ? { lastChanged: flag.ts } : {}),
        via,
      },
    }
  } catch {
    // Fail safe: never imply a bypass that is not in effect.
    return withState(
      'off',
      { bypassOn: false, via: 'none' as const },
      'bypass state unreadable — assuming prompts active',
      'permissionBypassBridge',
    )
  }
}
