import { flagEnv } from '../substrate/flagRegistry.js'
import { BASH_GLOB_PREAMBLE, type ShellOrigin } from './shellRecord.js'

export function getGlobPreambleCommand(origin: ShellOrigin): string | null {
  if (origin === 'engine' && !flagEnv('MERCURY_SHELL_PREFIX')) return null
  return BASH_GLOB_PREAMBLE
}
