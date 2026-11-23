import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { inputPrompt, options } = ports
  if (options.resumeSessionAt !== undefined && !options.resume) {
    process.stderr.write('--replay-to requires --resume\n')
    gracefulShutdownSync(1)
    return BOOT_ENDS
  }
  if (options.rewindFiles !== undefined && !options.resume) {
    process.stderr.write('--restore-files requires --resume\n')
    gracefulShutdownSync(1)
    return BOOT_ENDS
  }
  if (
    options.rewindFiles !== undefined &&
    typeof inputPrompt === 'string' &&
    inputPrompt.trim().length > 0
  ) {
    process.stderr.write('--restore-files is a standalone operation and cannot be combined with a prompt\n')
    gracefulShutdownSync(1)
    return BOOT_ENDS
  }
  return {}
}

export const refuseBadOptions: BootStep<never> = { name: 'refuseBadOptions', makes: [], run }
