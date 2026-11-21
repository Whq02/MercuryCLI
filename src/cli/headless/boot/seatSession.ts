import { saveSessionModel } from '../../../utils/sessionStorage.js'
import { getEngineModel } from '../../../services/model/model.js'
import { settleClearModel } from '../../../services/switchboard/sessionReceipts.js'
import { dirname } from 'node:path'
import { getTranscriptPath } from '../../../utils/sessionStorage/paths.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { recordTranscript } from '../../../utils/sessionStorage/writer.js'
import { logError } from '../../../utils/log.js'
import { toError } from '../../../utils/errors.js'
import type { AdvisorQuiet } from '../../../services/advisor/index.js'
import * as printDriver from '../printDriver.js'
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
  const landAdvisorQuiet = (quiet: AdvisorQuiet): void => printDriver.landAdvisorQuiet(quiet, ports)
  return { settleClearBirth, receivedUuids, interruptOutcomes, landAdvisorQuiet }
}

export const seatSession: BootStep<'settleClearBirth' | 'receivedUuids' | 'interruptOutcomes' | 'landAdvisorQuiet'> = { name: 'seatSession', makes: ['settleClearBirth', 'receivedUuids', 'interruptOutcomes', 'landAdvisorQuiet'], run }
