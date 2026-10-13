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
for (const family of [
  FILEPATH_EXECUTION_CMDLETS,
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  MODULE_LOADING_CMDLETS,
  'invoke-webrequest invoke-restmethod'.split(' '),
  'set-alias sal new-alias nal set-variable sv new-variable nv'.split(' '),
  'invoke-wmimethod iwmi invoke-cimmethod'.split(' '),
  'select-object sort-object group-object where-object measure-object write-output write-host start-sleep format-table format-list format-wide format-custom out-string out-host ipconfig hostname route'.split(' '),
  'pwsh powershell cmd bash wsl sh start-process start add-type new-object foreach-object'.split(' '),
  CROSS_PLATFORM_CODE_EXEC.filter(entry => entry.indexOf(' ') === -1),
]) {
  for (const name of family) suggestionExclusions.add(name.toLowerCase())
}

const excludedAliases: string[] = []
for (const [spelling, command] of Object.entries(COMMON_ALIASES)) {
  if (suggestionExclusions.has(command.toLowerCase())) excludedAliases.push(spelling.toLowerCase())
}
for (const spelling of excludedAliases) suggestionExclusions.add(spelling)

export const NEVER_SUGGEST: ReadonlySet<string> = suggestionExclusions
