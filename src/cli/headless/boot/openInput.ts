import { setRunInputClosed } from '../../../bootstrap/state.js'
import { noticeRow } from '../../../rows/project.js'
import { errorMessage } from '../../../utils/errors.js'
import { INPUT_REFUSED_CODE } from '../../structuredIO.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'stdinLoop'> {
  const { acceptInputRow, bootSettled, driver, enqueueRow, io, live, liveScope, peer, stopShellsForClose } = ports
  const stdinLoop = (async (): Promise<void> => {
    try {
      bootSettled()
      if (peer !== null) {
        await peer.done
        return
      }
      for await (const row of io.structuredInput) {
        try {
          await acceptInputRow(row)
        } catch (error) {
          enqueueRow(noticeRow(liveScope(), 'error', `input refused: ${errorMessage(error)}`, INPUT_REFUSED_CODE))
        }
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
