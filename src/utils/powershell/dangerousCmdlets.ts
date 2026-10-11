import { CROSS_PLATFORM_CODE_EXEC } from '../permissions/dangerousPatterns.js'
import { COMMON_ALIASES } from './parser.js'

const CMDLET_FAMILIES = {
  runsAFile: ['invoke-command', 'start-job', 'start-threadjob', 'register-scheduledjob'],
  runsAScriptBlock: [
    'invoke-command',
    'invoke-expression',
    'start-job',
    'start-threadjob',
    'register-scheduledjob',
    'register-engineevent',
    'register-objectevent',
    'register-wmievent',
    'new-pssession',
    'enter-pssession',
  ],
  loadsAModule: ['import-module', 'ipmo', 'install-module', 'save-module', 'update-module', 'install-script', 'save-script'],
  reachesTheNetwork: ['invoke-webrequest', 'invoke-restmethod'],
  rebindsNames: ['set-alias', 'sal', 'new-alias', 'nal', 'set-variable', 'sv', 'new-variable', 'nv'],
  invokesWmi: ['invoke-wmimethod', 'iwmi', 'invoke-cimmethod'],
  gatedByArguments: [
    'select-object',
    'sort-object',
    'group-object',
    'where-object',
    'measure-object',
    'write-output',
    'write-host',
    'start-sleep',
    'format-table',
    'format-list',
    'format-wide',
    'format-custom',
    'out-string',
    'out-host',
    'ipconfig',
    'hostname',
    'route',
  ],
  spawnsAShell: ['pwsh', 'powershell', 'cmd', 'bash', 'wsl', 'sh', 'start-process', 'start', 'add-type', 'new-object'],
} as const satisfies Record<string, readonly string[]>

export const FILEPATH_EXECUTION_CMDLETS: Set<string> = new Set(CMDLET_FAMILIES.runsAFile)
export const DANGEROUS_SCRIPT_BLOCK_CMDLETS: Set<string> = new Set(CMDLET_FAMILIES.runsAScriptBlock)
export const MODULE_LOADING_CMDLETS: Set<string> = new Set(CMDLET_FAMILIES.loadsAModule)

const lower = (name: string): string => name.toLowerCase()
const isOneWord = (entry: string): boolean => !entry.includes(' ')

const neverSuggested = (): ReadonlySet<string> => {
  const core = new Set(
    [...Object.values(CMDLET_FAMILIES).flat(), 'foreach-object', ...CROSS_PLATFORM_CODE_EXEC.filter(isOneWord)].map(lower),
  )
  const aliasesOfCore = Object.entries(COMMON_ALIASES)
    .filter(([, target]) => core.has(lower(target)))
    .map(([alias]) => lower(alias))
  return new Set([...core, ...aliasesOfCore])
}

export const NEVER_SUGGEST: ReadonlySet<string> = neverSuggested()
