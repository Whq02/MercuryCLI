import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { handleRewindFiles } from '../controlHandlers.js'
import type { UUID } from 'node:crypto'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<never>> {
  const { getAppState, messages, options, setAppState } = ports
  if (options.rewindFiles !== undefined) {
    const target = messages.find(
      message => (message as { uuid?: string }).uuid === options.rewindFiles,
    )
    if (!target || target.type !== 'user') {
      process.stderr.write(
        `Cannot rewind files to ${options.rewindFiles}: ${target ? 'the target is not a user message (file snapshots are only taken at user messages)' : 'no message with that uuid exists in the loaded session'}\n`,
      )
      gracefulShutdownSync(1)
      return BOOT_ENDS
    }
    const rewindResult = await handleRewindFiles(
      options.rewindFiles as UUID,
      getAppState(),
      setAppState,
      false,
    )
    if (rewindResult && rewindResult.can_rewind === false) {
      process.stderr.write(
        `${rewindResult.error ?? 'An unexpected error prevented the rewind'}\n`,
      )
      gracefulShutdownSync(1)
      return BOOT_ENDS
    }
    process.stdout.write(`Rewound files to message ${options.rewindFiles}\n`)
    gracefulShutdownSync(0)
    return BOOT_ENDS
  }
  return {}
}

export const restoreFilesAlone: BootStep<never> = { name: 'restoreFilesAlone', makes: [], run }
