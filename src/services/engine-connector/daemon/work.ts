import type { SessionFactsV1 } from '../seatProjections.js'
import type { CheckpointFactsV1, WorkRosterV1 } from '../types.js'
import { emitAll, type Listeners } from './shared.js'

const UNKNOWN_CHECKPOINTS: CheckpointFactsV1 = Object.freeze({ capture: 'unknown' as const, restorable: Object.freeze(new Set<string>()) as ReadonlySet<string> })

interface WorkNeeds {
  facts(): SessionFactsV1 | null
  carrierGone(): boolean
}

export class WorkPart {
  private readonly workListeners: Listeners = new Set()
  private workSnapshot: WorkRosterV1 = { rows: [], mission: [] }
  private workStamp = '[true,[],[]]'
  private readonly checkpointListeners: Listeners = new Set()
  private checkpointSnapshot: CheckpointFactsV1 = UNKNOWN_CHECKPOINTS
  private checkpointStamp = ''

  constructor(private readonly needs: WorkNeeds) {}

  refreshCheckpoints(): void {
    const fc = this.needs.facts()?.fileCheckpoints
    const stamp = fc === undefined ? '' : JSON.stringify([fc.capture, fc.restorable, fc.files, fc.undo])
    if (stamp === this.checkpointStamp) return
    this.checkpointStamp = stamp
    this.checkpointSnapshot =
      fc === undefined ? UNKNOWN_CHECKPOINTS : { capture: fc.capture ? 'on' : 'off', restorable: new Set(fc.restorable), ...(fc.files === undefined ? {} : { files: fc.files }), ...(fc.undo === undefined ? {} : { undo: fc.undo }) }
    emitAll(this.checkpointListeners, 'checkpoints')
  }

  checkpointFacts(): CheckpointFactsV1 {
    return this.checkpointSnapshot
  }

  subscribeCheckpoints(listener: () => void): () => void {
    this.checkpointListeners.add(listener)
    return () => {
      this.checkpointListeners.delete(listener)
    }
  }

  refreshWork(): void {
    const facts = this.needs.facts()
    const reported = facts?.work !== undefined
    const gone = this.needs.carrierGone()
    const rows = facts?.work ?? []
    const mission = facts?.mission ?? []
    const missionCard = facts?.missionCard ?? null
    const samples = facts?.samples ?? []
    const pauseGate = facts?.pauseGate
    const stamp = JSON.stringify([reported, gone, rows, mission, missionCard, samples, pauseGate, facts?.swarm?.snapshot, facts?.swarm?.on])
    if (stamp === this.workStamp) return
    this.workStamp = stamp
    this.workSnapshot = { rows, mission, missionCard, samples, ...(reported ? {} : { reported: false }), ...(gone ? { gone: true } : {}), ...(pauseGate !== undefined ? { pauseGate } : {}) }
    emitAll(this.workListeners, 'work')
  }

  workRoster(): WorkRosterV1 {
    return this.workSnapshot
  }

  subscribeWork(listener: () => void): () => void {
    this.workListeners.add(listener)
    return () => {
      this.workListeners.delete(listener)
    }
  }
}
