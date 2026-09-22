
export class CacheLatchOwner {
  promptCache1hEligible: boolean | null = null
  cacheEditingHeaderLatched: boolean | null = null
  systemPromptSectionCache: Map<
    string,
    { key: string | null; value: string | null; byKey?: Map<string, string | null> }
  > = new Map()
  lastEmittedDate: string | null = null

  clearBetaHeaderLatches(): void {
    this.cacheEditingHeaderLatched = null
  }
}
