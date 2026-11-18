import { setRunInputClosed } from '../../../bootstrap/state.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'stdinLoop'> {
  const { acceptInputRow, bootSettled, claimGatedInput, driver, io, live, peer, stopShellsForClose } = ports
  const stdinLoop = (async (): Promise<void> => {
    try {
      bootSettled()
      if (peer !== null) {
        await peer.done
        return
      }
      for await (const row of claimGatedInput(io.structuredInput)) {
        await acceptInputRow(row)
      }
    } finally {
      live.inputClosed = true
      setRunInputClosed(true)
      if (!driver.isRunning()) {
        await stopShellsForClose()
        await driver.closeOutputOnce()
      }
    }
  })()
  return { stdinLoop }
}

export const openInput: BootStep<'stdinLoop'> = { name: 'openInput', makes: ['stdinLoop'], run }
