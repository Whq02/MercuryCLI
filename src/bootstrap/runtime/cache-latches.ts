
export class CacheLatchOwner {
  promptCache1hEligible: boolean | null = null
  afkModeHeaderLatched: boolean | null = null
  cacheEditingHeaderLatched: boolean | null = null
  thinkingClearLatched: boolean | null = null
  systemPromptSectionCache: Map<
    string,
    { key: string | null; value: string | null }
  > = new Map()
  lastEmittedDate: string | null = null

  clearBetaHeaderLatches(): void {
    this.afkModeHeaderLatched = null
    this.cacheEditingHeaderLatched = null
    this.thinkingClearLatched = null
  }
}
