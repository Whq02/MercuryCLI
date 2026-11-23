import { emitLoadError } from '../resume.js'
import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { inputPrompt, options } = ports
  const resumeTargetValid =
    typeof options.resume === 'string' &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resume) ||
      options.resume.endsWith('.jsonl'))
  if (
    typeof inputPrompt === 'string' &&
    inputPrompt.length === 0 &&
    !resumeTargetValid
  ) {
    emitLoadError(
      'No prompt reached run: give one as the argument or on stdin',
      options.outputFormat,
    )
    gracefulShutdownSync(1)
    return BOOT_ENDS
  }
  return {}
}

export const refuseEmptyPrompt: BootStep<never> = { name: 'refuseEmptyPrompt', makes: [], run }
