import { readSessionWorkersSnapshot } from '../../../daemon/concourse-workers/concourseWorkers.js'

interface CompletionNeeds {
  sessionId(): string
  factsBusy(): boolean
  hasUnreadTranscript(): boolean
  tick(): Promise<void>
}

export class CompletionPart {
  private workerTurnSettledAtMs: number | null = null
  private workerTurnDeliveryAtMs: number | null = null
  private workerRecordPresent = false
  private completedTurnAtMs: number | null = null
  private completionWasInFlight = false
  private completionSawFactsBusy = false
  private sendDemotedToQueued = false
  private sendDeliveredTaken = false
  private completionHighWaterMs = 0
  private completionUnmatchedEdgeAtMs: number | null = null
  private completionUnmatchedStampAtMs: number | null = null

  constructor(private readonly needs: CompletionNeeds) {
    this.refreshWorkerTurnMarks()
    this.completionHighWaterMs = this.workerTurnSettledAtMs ?? 0
    this.completionWasInFlight = this.needs.factsBusy()
    this.completionSawFactsBusy = this.needs.factsBusy()
  }

  noteSendDemoted(): void {
    this.sendDemotedToQueued = true
  }

  noteSendTaken(): void {
    this.sendDeliveredTaken = true
  }

  lastTurnCompletedAtMs(): number | null {
    return this.completedTurnAtMs
  }

  refreshWorkerTurnMarks(): void {
    const snap = readSessionWorkersSnapshot()
    if (snap.state !== 'known') return
    let bestRank = -1
    let settled: number | null = null
    let delivery: number | null = null
    let present = false
    for (const rec of Object.values(snap.workers)) {
      if (rec.sessionId !== this.needs.sessionId() || rec.endedAt !== undefined) continue
      present = true
      const s = typeof rec.lastTurnSettledAt === 'number' && Number.isFinite(rec.lastTurnSettledAt) ? rec.lastTurnSettledAt : null
      const d = typeof rec.lastDeliveryAt === 'number' && Number.isFinite(rec.lastDeliveryAt) ? rec.lastDeliveryAt : null
      const rank = Math.max(s ?? 0, d ?? 0)
      if (rank >= bestRank) {
        bestRank = rank
        settled = s
        delivery = d
      }
    }
    this.workerRecordPresent = present
    this.workerTurnSettledAtMs = settled
    this.workerTurnDeliveryAtMs = delivery
  }

  stepTurnCompletion(inFlight: boolean): boolean {
    const rawEdge = this.completionWasInFlight && !inFlight
    const wasFactsBusy = this.completionSawFactsBusy
    const demotedToQueued = this.sendDemotedToQueued
    const deliveredTaken = this.sendDeliveredTaken
    this.sendDemotedToQueued = false
    this.sendDeliveredTaken = false
    const canSettleLater = this.workerRecordPresent
    const edge = rawEdge && !(demotedToQueued && !deliveredTaken && !wasFactsBusy && canSettleLater)
    this.completionWasInFlight = inFlight
    this.completionSawFactsBusy = inFlight ? (wasFactsBusy || this.needs.factsBusy()) : false
    const settled = this.workerTurnSettledAtMs
    const delivery = this.workerTurnDeliveryAtMs
    if (inFlight) {
      if (delivery !== null && this.completionUnmatchedStampAtMs !== null && delivery > this.completionUnmatchedStampAtMs) {
        this.completionUnmatchedStampAtMs = null
      }
      return false
    }
    const stampAdvanced = settled !== null && settled > this.completionHighWaterMs
    if ((edge || stampAdvanced) && this.needs.hasUnreadTranscript()) {
      if (edge) {
        this.completionWasInFlight = true
        this.completionSawFactsBusy = wasFactsBusy
      }
      void this.needs.tick()
      return false
    }
    if (edge && stampAdvanced) {
      this.completionHighWaterMs = settled
      this.completionUnmatchedEdgeAtMs = null
      this.completionUnmatchedStampAtMs = null
      this.completedTurnAtMs = Math.max(Date.now(), (this.completedTurnAtMs ?? 0) + 1)
      return true
    }
    if (edge) {
      if (this.completionUnmatchedStampAtMs !== null && (delivery === null || delivery <= this.completionUnmatchedStampAtMs)) {
        this.completionUnmatchedStampAtMs = null
        return false
      }
      const now = Date.now()
      this.completionUnmatchedEdgeAtMs = now
      this.completedTurnAtMs = Math.max(now, (this.completedTurnAtMs ?? 0) + 1)
      return true
    }
    if (stampAdvanced) {
      this.completionHighWaterMs = settled
      if (this.completionUnmatchedEdgeAtMs !== null && (delivery === null || delivery <= this.completionUnmatchedEdgeAtMs)) {
        this.completionUnmatchedEdgeAtMs = null
        return false
      }
      this.completionUnmatchedEdgeAtMs = null
      this.completionUnmatchedStampAtMs = settled
      this.completedTurnAtMs = Math.max(Date.now(), (this.completedTurnAtMs ?? 0) + 1)
      return true
    }
    return false
  }
}
