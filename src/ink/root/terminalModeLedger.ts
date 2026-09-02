// ============================================================================
//  terminalModeLedger —.6.2: the owner-scoped
//  record of terminal-mode acquisitions in THIS process.
//
//  The law: a surface releases ONLY what it acquired (or verifiably imported
//  through a settled handoff receipt) — never a broad reset in a normal path.
//  The ledger is the in-process bookkeeping that makes that law mechanical:
//  every acquisition/import notes {owner, mode, state}, release consults the
//  OPEN obligations for exactly that owner, and a surface that never touched
//  a mode has nothing to release by construction (the splash never touches
//  bracketed paste / mouse / keyboard protocol — UI-036; its transferable set
//  is alt-screen · alternate-scroll · cursor-hidden, ground riding oasisBg's
//  own mirror).
//
//  Cross-process truth rides the splash-action receipt (held / restored /
//  not-entered — the settled screen fact the launchers consume); THIS module
//  is per-process only. Pure state, no IO, no env.
// ============================================================================

export type TerminalMode =
  | 'alt-screen'
  | 'alternate-scroll'
  | 'cursor-hidden'
  | 'sync-update'
  | 'ground-osc'
  | 'bracketed-paste'
  | 'mouse-tracking'
  | 'kitty-kbd'
  // focus reporting (DECSET 1004) joins the
  // vocabulary — App's raw-mode arm acquires it; the splash never touches
  // it (the transferable set is unchanged).
  | 'focus-events'

export type ModeState = 'acquired' | 'imported' | 'released'

export interface TerminalModeRecord {
  owner: string
  mode: TerminalMode
  state: ModeState
}

const records: TerminalModeRecord[] = []

function upsert(owner: string, mode: TerminalMode, state: ModeState): void {
  const existing = records.find(r => r.owner === owner && r.mode === mode)
  if (existing) {
    existing.state = state
    return
  }
  records.push({ owner, mode, state })
}

/** This process itself entered the mode. */
export function noteModeAcquired(owner: string, mode: TerminalMode): void {
  upsert(owner, mode, 'acquired')
}

/** A settled handoff receipt transferred these modes INTO this process
 *  (the launcher-held splash screen) — they are release obligations exactly
 *  like our own acquisitions. */
export function noteModesImported(owner: string, modes: readonly TerminalMode[]): void {
  for (const mode of modes) upsert(owner, mode, 'imported')
}

/** The owner released the mode (emitted the closing bytes, or handed the
 *  obligation to a successor that now owns the screen). */
export function noteModeReleased(owner: string, mode: TerminalMode): void {
  upsert(owner, mode, 'released')
}

/** The OPEN obligations for an owner — exactly what its release path must
 *  emit, nothing more (the a-surface-releases-only-what-it-acquired law). */
export function openModeObligations(owner: string): TerminalMode[] {
  return records
    .filter(r => r.owner === owner && r.state !== 'released')
    .map(r => r.mode)
}

/** The full ledger (diagnostics / proofs). */
export function terminalModeLedgerSnapshot(): readonly TerminalModeRecord[] {
  return records.map(r => ({ ...r }))
}

/**
 * The PROCESS-WIDE shutdown-release derivation (the
 * adopted TM-01): exactly the modes still OPEN across every owner — what a
 * normal shutdown must release, and nothing more. gracefulShutdown consults
 * THIS instead of its historical broad unconditional reset: a process that
 * acquired nothing has nothing to release by construction (the
 * a-surface-releases-only-what-it-acquired law, extended to exit).
 * Deduplicated: two owners holding one mode yield one release.
 */
export function shutdownReleaseObligations(): TerminalMode[] {
  const open = new Set<TerminalMode>()
  for (const r of records) {
    if (r.state !== 'released') open.add(r.mode)
  }
  return [...open]
}

/**
 * Mark EVERY owner's open record of one mode released — the shutdown
 * writer's bookkeeping: after gracefulShutdown emits the gated
 * closing bytes for a still-open mode, the obligation is settled everywhere
 * (a failsafe re-run of the cleanup then has nothing left to write — the
 * exactly-once half of the settle-exact-obligations law).
 */
export function noteModeSettledEverywhere(mode: TerminalMode): void {
  for (const r of records) {
    if (r.mode === mode && r.state !== 'released') r.state = 'released'
  }
}

/** Proof seam — ledger state is process-lifetime. */
export function _resetTerminalModeLedgerForTesting(): void {
  records.length = 0
}
