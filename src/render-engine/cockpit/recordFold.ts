
export interface FoldOutcome {
  readonly uuid: string
  readonly outcome: 'recorded' | 'refolded'
  readonly foldKey: string
}

export interface RecordFoldOptions {
  onRefold?: (foldKey: string, firstUuid: string, freshUuid: string) => void
}

function roundOf(callId: string): string {
  const dot = callId.indexOf('.')
  return dot > 0 ? callId.slice(0, dot) : callId
}

export class RecordFold {
  private runSeq = 0
  private readonly byFoldKey = new Map<string, string>()
  private readonly attemptPositions = new Map<string, number>()
  private refoldCount = 0

  constructor(private readonly options: RecordFoldOptions = {}) {}

  beginRun(): void {
    this.runSeq++
    this.attemptPositions.clear()
  }

  ingestSettlement(callId: string, mintedUuid: string): FoldOutcome {
    const position = this.attemptPositions.get(callId) ?? 0
    this.attemptPositions.set(callId, position + 1)
    const foldKey = `r${this.runSeq}:${roundOf(callId)}:b${position}:assistant`
    const existing = this.byFoldKey.get(foldKey)
    if (existing !== undefined && existing !== mintedUuid) {
      this.refoldCount++
      this.options.onRefold?.(foldKey, existing, mintedUuid)
      return { uuid: existing, outcome: 'refolded', foldKey }
    }
    this.byFoldKey.set(foldKey, mintedUuid)
    return { uuid: mintedUuid, outcome: 'recorded', foldKey }
  }

  retractByUuid(uuid: string): void {
    for (const [key, held] of this.byFoldKey) {
      if (held === uuid) this.byFoldKey.delete(key)
    }
  }

  refolds(): number {
    return this.refoldCount
  }
}
