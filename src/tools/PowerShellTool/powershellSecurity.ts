/**
 * The PowerShell security battery. Returns ask or passthrough (never deny,
 * never allow). An invalid parse asks outright. Otherwise the twenty-four
 * checks run in the documented order and the first ask wins — the order
 * decides which message the user sees.
 */
import {
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../utils/powershell/dangerousCmdlets.js'
import { resolveToCanonical } from './readOnlyValidation.js'
import { isClmAllowedType } from './clmTypes.js'

type Verdict = { behavior: 'ask' | 'passthrough' | 'allow'; message?: string }
const PASS: Verdict = { behavior: 'passthrough' }
const ASK = (message: string): Verdict => ({ behavior: 'ask', message })

/** PowerShell dash / alternative prefixes normalised to `-`. */
function normArg(arg: string): string {
  return arg.replace(/^[/–—―]/, '-')
}

/** PowerShell executables (contract data). */
const PS_EXES = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])
function isPsExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  return PS_EXES.has(lower) || PS_EXES.has(lower.split(/[\\/]/).pop() ?? lower)
}

/** Whether a command element carries a parameter abbreviating `full` down to `min`. */
function hasParam(element: ParsedCommandElement, full: string, min: string): boolean {
  for (const raw of element.args) {
    let arg = normArg(raw).toLowerCase()
    const colon = arg.indexOf(':', 1)
    if (colon !== -1) arg = arg.slice(0, colon)
    if (arg.startsWith(min) && full.startsWith(arg)) return true
  }
  return false
}

/** The main entry. */
export function powershellCommandIsSafe(_command: string, parsed: ParsedPowerShellCommand): Verdict {
  if (!parsed.valid) return ASK('The command could not be parsed for security analysis.')
  const commands = getAllCommands(parsed)
  const names = commands.map(c => resolveToCanonical(c.name))
  const flags = deriveSecurityFlags(parsed)

  const has = (name: string): boolean => names.includes(name)

  // 1. Invoke-Expression.
  if (has('invoke-expression')) return ASK('The command can execute arbitrary code via Invoke-Expression.')
  // 2. Dynamic command name.
  for (const command of commands) {
    if (command.elementType !== 'Command') continue
    const type = command.elementTypes?.[0]
    if (type === undefined) continue // fail open
    if (type !== 'StringConstant') return ASK('The command name is computed at runtime and cannot be validated.')
  }
  // 3. Encoded command / 4. nested PowerShell.
  for (const command of commands) {
    if (isPsExecutable(command.name)) {
      if (hasParam(command, '-encodedcommand', '-e')) return ASK('The command uses parameters that obscure its intent (an encoded command).')
      return ASK('The command spawns a nested PowerShell process that cannot be validated.')
    }
  }
  // 5. Download cradles.
  const DOWNLOADERS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'new-object', 'start-bitstransfer'])
  const EVALS = new Set(['invoke-expression', 'iex'])
  const rawNames = commands.map(c => c.name.toLowerCase())
  if (names.some(n => DOWNLOADERS.has(n)) && names.some(n => EVALS.has(n))) {
    return ASK('The command downloads and executes remote code.')
  }
  // 6. Standalone download utilities.
  if (has('start-bitstransfer')) return ASK('The command downloads a file via BITS.')
  for (const command of commands) {
    const lower = command.name.toLowerCase()
    if ((lower === 'certutil' || lower === 'certutil.exe') && command.args.some(a => /^[-/]urlcache$/i.test(a))) {
      return ASK('The command downloads from a URL via certutil.')
    }
    if ((lower === 'bitsadmin' || lower === 'bitsadmin.exe') && command.args.some(a => /^\/transfer$/i.test(a))) {
      return ASK('The command transfers a file via bitsadmin.')
    }
  }
  // 7. Add-Type.
  if (has('add-type')) return ASK('The command compiles and loads .NET code via Add-Type.')
  // 8. COM / .NET type instantiation on new-object.
  for (const command of commands) {
    if (resolveToCanonical(command.name) !== 'new-object') continue
    if (hasParam(command, '-comobject', '-com')) return ASK('The command instantiates a COM object, which may have execution capabilities.')
    const typeName = extractNewObjectType(command)
    if (typeName !== null && !isClmAllowedType(typeName)) return ASK(`The command instantiates a type outside the allowlist: ${typeName}.`)
  }
  // 9. Script-file execution.
  for (const command of commands) {
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolveToCanonical(command.name))) continue
    if (hasParam(command, '-filepath', '-f') || hasParam(command, '-literalpath', '-l')) return ASK('The command executes a script file.')
    const types = command.elementTypes
    if (command.args.some((a, i) => (types ? types[i] === 'StringConstant' : true) && !a.startsWith('-'))) {
      return ASK('The command executes a script file (positional path).')
    }
  }
  // 10. Invoke-Item.
  if (has('invoke-item')) return ASK('Invoke-Item opens files with the default handler; on an executable this runs arbitrary code.')
  // 11. Scheduled tasks.
  const SCHED = new Set(['register-scheduledtask', 'new-scheduledtask', 'new-scheduledtaskaction', 'set-scheduledtask'])
  for (const command of commands) {
    if (SCHED.has(resolveToCanonical(command.name))) return ASK(`${command.name} creates or modifies a scheduled task (a persistence primitive).`)
    const lower = command.name.toLowerCase()
    if ((lower === 'schtasks' || lower === 'schtasks.exe') && command.args.some(a => /^[-/](?:create|change)$/i.test(a))) {
      return ASK('The command creates or changes a scheduled task.')
    }
  }
  // 12. ForEach-Object member invocation.
  for (const command of commands) {
    if (resolveToCanonical(command.name) !== 'foreach-object') continue
    if (hasParam(command, '-membername', '-m')) return ASK('ForEach-Object invokes a method by string name, which cannot be validated.')
    const types = command.elementTypes
    if (command.args.some((a, i) => (types ? types[i] === 'StringConstant' : true) && !a.startsWith('-'))) {
      return ASK('ForEach-Object invokes a method by string name, which cannot be validated.')
    }
  }
  // 13. Start-Process.
  for (const command of commands) {
    const lower = command.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') continue
    if (hasParam(command, '-verb', '-v') && command.args.some(a => /^runas$/i.test(a.replace(/`/g, '')))) {
      return ASK('The command requests elevated privileges (runas).')
    }
    if (command.args.some(a => { let v = a.replace(/`/g, ''); if (/^['"]/.test(v)) v = v.slice(1); if (/['"]$/.test(v)) v = v.slice(0, -1); return isPsExecutable(v) })) {
      return ASK('The command launches an unvalidatable nested PowerShell.')
    }
  }
  // 14. Script-block injection.
  if (flags.hasScriptBlocks) {
    const SAFE_BLOCK = new Set(['where-object', 'sort-object', 'select-object', 'group-object', 'format-table', 'format-list', 'format-wide', 'format-custom'])
    if (names.some(n => DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(n))) return ASK('A script block contains a dangerous cmdlet that may execute arbitrary code.')
    if (!names.every(n => SAFE_BLOCK.has(n))) return ASK('The command contains a script block that may execute arbitrary code.')
  }
  // 15-19 security flags.
  if (flags.hasSubExpressions) return ASK('The command contains sub-expressions.')
  if (flags.hasExpandableStrings) return ASK('The command embeds expressions inside string literals.')
  if (flags.hasSplatting) return ASK('The command uses splatting, which obscures arguments.')
  if (flags.hasStopParsing) return ASK('The command uses the stop-parsing token, preventing further parsing.')
  if (flags.hasMemberInvocations) return ASK('The command invokes .NET methods.')
  // 20. Type literals.
  for (const type of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(type)) return ASK(`The command uses a type literal outside the allowlist: ${type}.`)
  }
  // 21. Environment-variable manipulation.
  const ENV_WRITE = new Set(['set-item', 'si', 'new-item', 'ni', 'remove-item', 'ri', 'del', 'rm', 'rd', 'rmdir', 'erase', 'clear-item', 'cli', 'set-content', 'add-content', 'ac'])
  if (getVariablesByScope(parsed, 'env').length > 0 && (rawNames.some(n => ENV_WRITE.has(n)) || flags.hasAssignments)) {
    return ASK('The command modifies environment variables.')
  }
  // 22. Module loading.
  if (names.some(n => MODULE_LOADING_CMDLETS.has(n))) return ASK('The command loads, installs, or downloads a module, which can execute arbitrary code.')
  // 23. Runtime-state manipulation.
  const STATE = new Set(['set-alias', 'sal', 'new-alias', 'nal', 'set-variable', 'sv', 'new-variable', 'nv'])
  for (const command of commands) {
    const stripped = command.name.toLowerCase().replace(/^[\w.]+\\/, '')
    if (STATE.has(stripped)) return ASK('The command creates or modifies an alias or variable, affecting future command resolution.')
  }
  // 24. WMI/CIM process spawn.
  const WMI = new Set(['invoke-wmimethod', 'iwmi', 'invoke-cimmethod'])
  for (const command of commands) {
    if (WMI.has(resolveToCanonical(command.name))) return ASK(`${command.name} can spawn arbitrary processes through WMI/CIM.`)
  }
  return PASS
}

/** Extract a New-Object type name from a string argument, or null. */
function extractNewObjectType(command: ParsedCommandElement): string | null {
  const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
  const SWITCHES = new Set(['-strict'])
  // First: a type-name parameter (colon or space form, abbreviated from -t).
  for (let i = 0; i < command.args.length; i++) {
    let arg = normArg(command.args[i] as string).toLowerCase()
    const colon = arg.indexOf(':', 1)
    const name = colon === -1 ? arg : arg.slice(0, colon)
    if (name.startsWith('-t') && '-typename'.startsWith(name)) {
      if (colon !== -1) return (command.args[i] as string).slice(normArg(command.args[i] as string).indexOf(':') + 1)
      return command.args[i + 1] ?? null
    }
  }
  // Second: the first positional argument.
  for (let i = 0; i < command.args.length; i++) {
    let arg = normArg(command.args[i] as string).toLowerCase()
    if (!arg.startsWith('-')) return command.args[i] as string
    const name = arg.split(':')[0] as string
    if (name.startsWith('-t') && '-typename'.startsWith(name)) { i++; continue }
    if (arg.includes(':')) continue // colon-bound single token
    if (SWITCHES.has(name)) continue
    if (VALUE_PARAMS.has(name)) { i++; continue }
    // unknown parameter: skip without consuming a value
  }
  return null
}
