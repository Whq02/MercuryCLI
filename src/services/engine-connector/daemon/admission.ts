import type { SessionFactsV1 } from '../seatProjections.js'

type RunnerFact = NonNullable<SessionFactsV1['runner']>

interface AdmissionNeeds {
  wakeLive(): void
}

export class AdmissionPart {
  private openedAtMs = Date.now()
  private startShownSinceMs: number | null = null
  private seedFactsAtMs: number | null = null
  private awaitingRunnerFacts = false
  private admission: Promise<string | null> | null = null
  private refusedAdmission: string | null = null

  constructor(private readonly needs: AdmissionNeeds) {}

  seed(factsAtMs: number | null, awaitingRunner: boolean): void {
    this.seedFactsAtMs = factsAtMs
    this.awaitingRunnerFacts = awaitingRunner
  }

  awaiting(): boolean {
    return this.awaitingRunnerFacts
  }

  pending(): Promise<string | null> | null {
    return this.admission
  }

  parksAgain(runnerId: string): boolean {
    return runnerId === '' && (!this.awaitingRunnerFacts || this.refusedAdmission !== null)
  }

  parked(factsAtMs: number | null): void {
    this.seedFactsAtMs = factsAtMs
    this.openedAtMs = Date.now()
    this.startShownSinceMs = null
    this.refusedAdmission = null
    this.awaitingRunnerFacts = true
  }

  runnerLive(): void {
    this.refusedAdmission = null
    if (this.awaitingRunnerFacts) {
      this.awaitingRunnerFacts = false
      this.startShownSinceMs = this.openedAtMs
    }
  }

  awaitAdmission(admission: Promise<string | null>): void {
    this.admission = admission
    if (this.refusedAdmission !== null) {
      this.refusedAdmission = null
      this.needs.wakeLive()
    }
    void admission.then(refusal => {
      if (this.admission !== admission) return
      if (refusal !== null) {
        this.refusedAdmission = refusal
        this.needs.wakeLive()
      }
    })
    void admission.finally(() => {
      if (this.admission === admission) this.admission = null
    })
  }

  admissionRefusal(): string | null {
    return this.refusedAdmission
  }

  factsArrive(atMs: number): boolean {
    if (this.awaitingRunnerFacts) {
      if (this.seedFactsAtMs !== null && atMs <= this.seedFactsAtMs) return false
      this.awaitingRunnerFacts = false
      this.startShownSinceMs = this.refusedAdmission === null ? this.openedAtMs : null
      this.refusedAdmission = null
    }
    return true
  }

  runnerReported(runner: RunnerFact | undefined): void {
    if (runner?.state !== 'starting' || runner.respawns !== 0) this.startShownSinceMs = null
  }

  sendDelivered(): void {
    if (this.refusedAdmission !== null) {
      this.refusedAdmission = null
      if (this.awaitingRunnerFacts) this.openedAtMs = Date.now()
    }
  }

  runnerShown(runner: RunnerFact | null): RunnerFact | null {
    return this.awaitingRunnerFacts
      ? this.refusedAdmission !== null
        ? null
        : { state: 'starting', sinceMs: this.openedAtMs, respawns: 0, maxRespawns: 0 }
      : this.runnerOnTheShownClock(runner)
  }

  private runnerOnTheShownClock(runner: RunnerFact | null): RunnerFact | null {
    if (runner === null || this.startShownSinceMs === null || runner.sinceMs <= this.startShownSinceMs) return runner
    return { ...runner, sinceMs: this.startShownSinceMs }
  }
}
