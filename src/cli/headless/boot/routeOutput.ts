import { type OutboundLine, isRowLine } from '../../structuredIO.js'
import type { Row, OutcomeRow } from '../../../rows/vocabulary.js'
import { isOutcome } from '../../../rows/read.js'
import { logError } from '../../../utils/log.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'writeLine' | 'routeOutbound'> {
  const { foldLanded, io, live, options, peer } = ports
  live.lastOutcomeWritten = Promise.resolve()
  const writeLine = (message: OutboundLine): Promise<Row | null> => {
    if (peer === null) return io.write(message)
    if (io.stdoutPipeBroken) return Promise.resolve(null)
    if (isRowLine(message)) {
      const row = io.rows.stamp(message)
      peer.notify('row', row)
      return peer.flush().then(() => row)
    }
    if (message.method === 'elicitation/complete') {
      if (live.capabilities.elicitation) peer.notify(message.method, message.params)
    } else peer.notify(message.method, message.params)
    return peer.flush().then(() => null)
  }
  const routeOutbound = (message: OutboundLine): void => {
    foldLanded(message)
    if (options.outputFormat === 'rows') {
      const written = writeLine(message)
      if (isOutcome(message)) {
        live.lastOutcomeWritten = written.then(line => {
          if (line !== null) live.lastOutcome = line as OutcomeRow
        })
      }
      void written.catch(error => logError(error))
      return
    }
    if (isOutcome(message)) live.lastOutcome = io.rows.stamp(message)
  }
  return { writeLine, routeOutbound }
}

export const routeOutput: BootStep<'writeLine' | 'routeOutbound'> = { name: 'routeOutput', makes: ['writeLine', 'routeOutbound'], run }
