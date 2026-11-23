import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

function run(ports: RunnerPorts): BootMade<'serializeMcpChange'> {
  const { live } = ports
  live.mcpChangeChain = Promise.resolve()
  const serializeMcpChange = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = live.mcpChangeChain.then(operation, operation)
    live.mcpChangeChain = next.catch(passedOver)
    return next
  }
  return { serializeMcpChange }
}

export const laneMcpChanges: BootStep<'serializeMcpChange'> = { name: 'laneMcpChanges', makes: ['serializeMcpChange'], run }
