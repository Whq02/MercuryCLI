
export type TerminalMode =
  | 'alt-screen'
  | 'alternate-scroll'
  | 'cursor-hidden'
  | 'sync-update'
  | 'ground-osc'
  | 'bracketed-paste'
  | 'mouse-tracking'
  | 'kitty-kbd'
  | 'focus-events'
  | 'progress-ring'
  | 'terminal-title'

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

export function noteModeAcquired(owner: string, mode: TerminalMode): void {
  upsert(owner, mode, 'acquired')
}

export function noteModesImported(owner: string, modes: readonly TerminalMode[]): void {
  for (const mode of modes) upsert(owner, mode, 'imported')
}

export function noteModeReleased(owner: string, mode: TerminalMode): void {
  upsert(owner, mode, 'released')
}

export function openModeObligations(owner: string): TerminalMode[] {
  return records
    .filter(r => r.owner === owner && r.state !== 'released')
    .map(r => r.mode)
}

export function terminalModeLedgerSnapshot(): readonly TerminalModeRecord[] {
  return records.map(r => ({ ...r }))
}

export function shutdownReleaseObligations(): TerminalMode[] {
  const open = new Set<TerminalMode>()
  for (const r of records) {
    if (r.state !== 'released') open.add(r.mode)
  }
  return [...open]
}

export function noteModeSettledEverywhere(mode: TerminalMode): void {
  for (const r of records) {
    if (r.mode === mode && r.state !== 'released') r.state = 'released'
  }
}

export function _resetTerminalModeLedgerForTesting(): void {
  records.length = 0
}
