import { CROSS_PLATFORM_CODE_EXEC } from '../permissions/dangerousPatterns.js'
import { COMMON_ALIASES } from './parser.js'

export const FILEPATH_EXECUTION_CMDLETS: Set<string> = new Set([
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
])

export const DANGEROUS_SCRIPT_BLOCK_CMDLETS: Set<string> = new Set([
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
])

export const MODULE_LOADING_CMDLETS: Set<string> = new Set([
  'import-module',
  'ipmo',
  'install-module',
  'save-module',
  'update-module',
  'install-script',
  'save-script',
])

export const NETWORK_CMDLETS: Set<string> = new Set(['invoke-webrequest', 'invoke-restmethod'])

export const ALIAS_HIJACK_CMDLETS: Set<string> = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

export const WMI_CIM_CMDLETS: Set<string> = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

export const ARG_GATED_CMDLETS: Set<string> = new Set([
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
])

const SHELLS_AND_SPAWNERS: string[] = [
  'pwsh',
  'powershell',
  'cmd',
  'bash',
  'wsl',
  'sh',
  'start-process',
  'start',
  'add-type',
  'new-object',
]

function deriveNeverSuggest(): ReadonlySet<string> {
  const core = new Set<string>()
  const addAll = (names: Iterable<string>): void => {
    for (const name of names) core.add(name.toLowerCase())
  }
  addAll(SHELLS_AND_SPAWNERS)
  addAll(FILEPATH_EXECUTION_CMDLETS)
  addAll(DANGEROUS_SCRIPT_BLOCK_CMDLETS)
  addAll(MODULE_LOADING_CMDLETS)
  addAll(NETWORK_CMDLETS)
  addAll(ALIAS_HIJACK_CMDLETS)
  addAll(WMI_CIM_CMDLETS)
  addAll(ARG_GATED_CMDLETS)
  core.add('foreach-object')
  for (const entry of CROSS_PLATFORM_CODE_EXEC) {
    if (!entry.includes(' ')) core.add(entry.toLowerCase())
  }
  for (const [alias, target] of Object.entries(COMMON_ALIASES)) {
    if (core.has(target.toLowerCase())) core.add(alias.toLowerCase())
  }
  return core
}

export const NEVER_SUGGEST: ReadonlySet<string> = deriveNeverSuggest()
