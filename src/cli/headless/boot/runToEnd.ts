import { pumpOutbound, finishPrintRun } from '../printRunEnd.js'
import { logError } from '../../../utils/log.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<never>> {
  const { stdinLoop } = ports
  const unwrittenRecord = await pumpOutbound(ports)
  await stdinLoop.catch((error: unknown) => {
    logError(error)
  })

  await finishPrintRun(unwrittenRecord, ports)
  return {}
}

export const runToEnd: BootStep<never> = { name: 'runToEnd', makes: [], run }
