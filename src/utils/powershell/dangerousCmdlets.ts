/**
 * Named catalogues of PowerShell cmdlets that execute code / load modules /
 * hit the network / rebind names, plus the derived "never suggest as a
 * permission-rule prefix" set. All names lowercase; all lookups
 * case-insensitive.
 */
import { CROSS_PLATFORM_CODE_EXEC } from '../permissions/dangerousPatterns.js'
import { COMMON_ALIASES } from './parser.js'

/** Cmdlets that accept a path and execute the file's contents. */
export const FILEPATH_EXECUTION_CMDLETS: Set<string> = new Set([
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
])

/** Cmdlets whose script-block argument executes code. */
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

/** Cmdlets that run a module's top-level body on import. */
export const MODULE_LOADING_CMDLETS: Set<string> = new Set([
  'import-module',
  'ipmo',
  'install-module',
  'save-module',
  'update-module',
  'install-script',
  'save-script',
])

/** Network cmdlets (download / exfiltration). */
export const NETWORK_CMDLETS: Set<string> = new Set(['invoke-webrequest', 'invoke-restmethod'])

/** Alias/variable mutation cmdlets (rebind resolution / poison defaults). */
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

/** WMI/CIM method invocation (process creation bypass). */
export const WMI_CIM_CMDLETS: Set<string> = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

/** Cmdlets a cmdlet-allowlist auto-allows for inert arguments via a callback. */
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

/** Internal-only: shells and process spawners (feeds the derivation only). */
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

/**
 * The derived never-suggest set: the union of the shells/spawners list, all
 * six validator lists, the argument-gated list, foreach-object, every
 * single-word cross-platform code-exec entry, and every alias whose target is
 * a member of the derived core set. Derived (not hand-maintained) so adding a
 * cmdlet to a validator list automatically removes it from suggestions.
 */
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
  // Every single-word entry of the cross-platform code-exec list (multi-word
  // entries like `npm run` are filtered out — this is a single-name lookup).
  for (const entry of CROSS_PLATFORM_CODE_EXEC) {
    if (!entry.includes(' ')) core.add(entry.toLowerCase())
  }
  // Every alias whose target is in the derived core set (computed once).
  for (const [alias, target] of Object.entries(COMMON_ALIASES)) {
    if (core.has(target.toLowerCase())) core.add(alias.toLowerCase())
  }
  return core
}

/** The derived never-suggest set plus aliases. */
export const NEVER_SUGGEST: ReadonlySet<string> = deriveNeverSuggest()
