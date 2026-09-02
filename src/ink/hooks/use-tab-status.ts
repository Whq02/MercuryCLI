// Per-tab status indicator (OSC 21337). RULED (operator drop-dead-machinery
// ruling): the emission lane is dark three gates deep in the
// shipped build, so the hook keeps its exported shape and does nothing. The
// parsing side of the extension lives in the OSC layer and stays live.

export type TabStatusKind = 'idle' | 'busy' | 'waiting'

export function useTabStatus(kind: TabStatusKind | null): void {
  void kind
}
