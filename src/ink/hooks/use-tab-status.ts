
export type TabStatusKind = 'idle' | 'busy' | 'waiting'

export function useTabStatus(kind: TabStatusKind | null): void {
  void kind
}
