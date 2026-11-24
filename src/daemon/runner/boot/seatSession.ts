import { saveSessionModel } from '../../../sessions/transcripts/sessionStorage.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { settleClearModel } from '../../switchboard/sessionReceipts.js'
import { dirname } from 'node:path'
import { getTranscriptPath } from '../../../sessions/transcripts/paths.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { recordTranscript } from '../../../sessions/transcripts/writer.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { toError } from '../../../platform/errors/errors.js'
import type { AdvisorQuiet } from '../../../models/advisor/index.js'
import * as runnerDriver from '../runnerDriver.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

const RECEIVED_UUID_CAP = 10_000

class BoundedUuidSet {
  readonly #order: string[] = []
  readonly #set = new Set<string>()
  constructor(private readonly cap: number) {}
  add(value: string): void {
    if (this.#set.has(value)) return
    this.#set.add(value)
    this.#order.push(value)
    while (this.#order.length > this.cap) {
      const oldest = this.#order.shift()
      if (oldest !== undefined) this.#set.delete(oldest)
    }
  }
  has(value: string): boolean {
    return this.#set.has(value)
  }
}

function run(ports: RunnerPorts): BootMade<'settleClearBirth' | 'receivedUuids' | 'interruptOutcomes' | 'landAdvisorQuiet'> {
  const { agents, asks, commands, isConcourseWorker, live, messages, options } = ports
  live.activeModel = live.bootModel
  saveSessionModel(live.activeModel ?? getEngineModel())
  const settleClearBirth = (): void => {
    try {
      const row = settleClearModel(dirname(getTranscriptPath()), String(getSessionId()), live.activeModel ?? getEngineModel())
      if (row !== null && !messages.some(message => message.uuid === row.uuid)) {
        messages.push(row)
        void recordTranscript([row], undefined, messages).catch((error: unknown) => logError(toError(error)))
      }
    } catch (error) {
      logError(toError(error))
    }
  }
  if (isConcourseWorker && !live.awaitingSessionClaim) settleClearBirth()
  live.thinkingConfig = options.thinkingConfig
  live.activeCommands = commands
  live.activeAgents = agents
  const receivedUuids = new BoundedUuidSet(RECEIVED_UUID_CAP)
  const interruptOutcomes = new Map<string, boolean>()
  asks.setOnControlRequestSent(() => live.hostAsks?.noteParked())
  asks.setOnControlRequestResolved(() => live.hostAsks?.noteSettled())
  const landAdvisorQuiet = (quiet: AdvisorQuiet): void => runnerDriver.landAdvisorQuiet(quiet, ports)
  return { settleClearBirth, receivedUuids, interruptOutcomes, landAdvisorQuiet }
}

export const seatSession: BootStep<'settleClearBirth' | 'receivedUuids' | 'interruptOutcomes' | 'landAdvisorQuiet'> = { name: 'seatSession', makes: ['settleClearBirth', 'receivedUuids', 'interruptOutcomes', 'landAdvisorQuiet'], run }
