import { armInactivityDeadline } from '../../../platform/async/deadline.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { SessionFactsV1 } from '../seatProjections.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const BUSY_STALL_MS = 45_000
const CARRIER_GONE_TICKS = 3

interface CarrierNeeds {
  sessionId(): string
  rpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  factsBusy(): boolean
  factsAtMs(): number
  dropBusy(): void
  recomputeLive(): void
  carrierWentAway(): void
}

export class CarrierPart {
  private busyStallDeadline: ReturnType<typeof armInactivityDeadline> | null = null
  private carrierGoneTicks = 0
  private carrierGoneAtFactsMs: number | null = null
  private carrierProbeInFlight = false
  private carrierSeen = false

  constructor(private readonly needs: CarrierNeeds) {}

  gone(): boolean {
    return this.carrierGoneAtFactsMs !== null
  }

  armBusyStall(): void {
    if (this.busyStallDeadline !== null) {
      this.busyStallDeadline.touch()
      return
    }
    const deadline = armInactivityDeadline({
      seam: 'engine-connector.factsBusy',
      limitMs: BUSY_STALL_MS,
      advice: 'the chat turn indicator was busy with no facts movement — probing the session host',
    })
    this.busyStallDeadline = deadline
    void deadline.expiry.catch(() => {
      if (this.busyStallDeadline !== deadline) return
      this.busyStallDeadline = null
      this.probeStalledTurn()
    })
  }

  disarmBusyStall(): void {
    this.busyStallDeadline?.cancel()
    this.busyStallDeadline = null
  }

  private probeStalledTurn(): void {
    void this.needs.rpc({ op: 'sessionControl', action: 'session-facts', sessionId: this.needs.sessionId(), by: 'operator' })
      .then(reply => {
        const r = reply as { ok?: boolean; outcome?: string; detail?: string }
        if (r.ok === true && r.outcome !== 'refused') {
          if (this.needs.factsBusy()) this.armBusyStall()
          return
        }
        this.settleStalledTurn(`daemon: ${r.detail ?? r.outcome ?? 'refused'}`)
      })
      .catch(e => this.settleStalledTurn(`daemon unreachable: ${e}`))
  }

  private settleStalledTurn(why: string): void {
    if (!this.needs.factsBusy()) return
    logForDebugging(`[engine-connector] busy turn stalled ${BUSY_STALL_MS}ms with no facts and no live runner — settling idle (${why})`)
    this.needs.dropBusy()
    this.needs.recomputeLive()
  }

  probeCarrier(): void {
    if (this.carrierProbeInFlight || this.carrierGoneAtFactsMs !== null) return
    this.carrierProbeInFlight = true
    void this.carrierVerdict()
      .then(verdict => {
        if (verdict !== 'gone') {
          this.carrierGoneTicks = 0
          return
        }
        this.carrierGoneTicks += 1
        if (this.carrierGoneTicks >= CARRIER_GONE_TICKS) this.settleCarrierGone()
      })
      .catch(passedOver)
      .finally(() => {
        this.carrierProbeInFlight = false
      })
  }

  private async carrierVerdict(): Promise<'alive' | 'gone' | 'unknown'> {
    const { readDaemonState } = await import('../../../daemon/control/controlSocket.js')
    const { isProcessAlive } = await import('../../../daemon/control/ownerWatch.js')
    const state = await readDaemonState()
    if (state === null) return this.carrierSeen ? 'gone' : 'unknown'
    if (state.state === 'stopping' || !isProcessAlive(state.pid)) return 'gone'
    this.carrierSeen = true
    return 'alive'
  }

  private settleCarrierGone(): void {
    if (this.carrierGoneAtFactsMs !== null) return
    this.carrierGoneAtFactsMs = this.needs.factsAtMs()
    logForDebugging(`[engine-connector] the daemon carrying ${this.needs.sessionId()} is gone (${CARRIER_GONE_TICKS} reads) — settling idle, dropping its work rows, saying so`)
    this.needs.dropBusy()
    this.disarmBusyStall()
    this.needs.carrierWentAway()
  }

  factsFromCarrier(next: SessionFactsV1): SessionFactsV1 {
    if (this.carrierGoneAtFactsMs === null) return next
    if (next.atMs !== this.carrierGoneAtFactsMs) {
      this.carrierGoneAtFactsMs = null
      this.carrierGoneTicks = 0
      return next
    }
    return { ...next, busy: false, work: [], mission: [], samples: [] }
  }
}
