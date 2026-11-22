import { COMMON_ALIASES } from './parser.js'
import { CROSS_PLATFORM_CODE_EXEC } from '../permissions/dangerousPatterns.js'

const scriptEntrypoints = new Map<string, boolean>([
  ['invoke-command', true],
  ['invoke-expression', false],
  ['start-job', true],
  ['start-threadjob', true],
  ['register-scheduledjob', true],
  ['register-engineevent', false],
  ['register-objectevent', false],
  ['register-wmievent', false],
  ['new-pssession', false],
  ['enter-pssession', false],
])

export const DANGEROUS_SCRIPT_BLOCK_CMDLETS: Set<string> = new Set(scriptEntrypoints.keys())
export const FILEPATH_EXECUTION_CMDLETS: Set<string> = new Set(
  [...scriptEntrypoints].flatMap(([name, takesFile]) => takesFile ? [name] : []),
)
export const MODULE_LOADING_CMDLETS: Set<string> = new Set(
  'import-module ipmo install-module save-module update-module install-script save-script'.split(' '),
)

const suggestionExclusions = new Set<string>()

const excludedAliases: string[] = []
for (const [spelling, command] of Object.entries(COMMON_ALIASES)) {
  if (suggestionExclusions.has(command.toLowerCase())) excludedAliases.push(spelling.toLowerCase())
}
for (const spelling of excludedAliases) suggestionExclusions.add(spelling)

export const NEVER_SUGGEST: ReadonlySet<string> = suggestionExclusions
