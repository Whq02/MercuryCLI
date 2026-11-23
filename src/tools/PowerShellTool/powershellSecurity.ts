import {
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../utils/powershell/parser.js'
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

function normArg(arg: string): string {
  return arg.replace(/^[/–—―]/, '-')
}

const PS_EXES = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])
function isPsExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  return PS_EXES.has(lower) || PS_EXES.has(lower.split(/[\\/]/).pop() ?? lower)
}

function baseExeName(name: string): string {
  const leaf = name.toLowerCase().split(/[\\/]/).pop() ?? name.toLowerCase()
  return leaf.replace(/\.(?:exe|cmd|bat|com)$/i, '')
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value[0] === "'" && value[value.length - 1] === "'") ||
      (value[0] === '"' && value[value.length - 1] === '"'))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function isParamToken(element: ParsedCommandElement, index: number): boolean {
  const kind = argumentTypeAt(element, index)
  if (kind !== undefined) return kind === 'Parameter'
  const raw = element.args[index] ?? ''
  return /^[-/–—―]/.test(raw)
}

function splitParam(raw: string): { name: string; inlineValue: string | undefined } {
  const norm = normArg(raw)
  const colon = norm.indexOf(':', 1)
  if (colon !== -1) {
    return { name: norm.slice(0, colon).toLowerCase(), inlineValue: raw.slice(colon + 1) }
  }
  return { name: norm.toLowerCase(), inlineValue: undefined }
}

function hasParam(element: ParsedCommandElement, full: string, min: string): boolean {
  for (const raw of element.args) {
    const { name } = splitParam(raw)
    if (name.startsWith(min) && full.startsWith(name)) return true
  }
  return false
}

const DOWNLOAD_CMDLETS = new Set([
  'invoke-webrequest',
  'invoke-restmethod',
  'new-object',
  'start-bitstransfer',
])

const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
])

const ENV_WRITING_CMDLETS = new Set([
  'set-item',
  'new-item',
  'remove-item',
  'clear-item',
  'set-content',
  'add-content',
  'clear-content',
  'set-variable',
  'remove-variable',
  'clear-variable',
])

const STATE_MUTATION_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

const WMI_CIM_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

const FILEPATH_CMDLET_SWITCHES = new Set([
  '-asjob',
  '-indisconnectedsession',
  '-hidecomputername',
  '-nonewscope',
  '-remotedebug',
  '-runas32',
  '-allowredirection',
  '-enablenetworkaccess',
  '-usessl',
  '-runnow',
  '-verbose',
  '-debug',
  '-whatif',
  '-confirm',
])

const FOREACH_SWITCHES = new Set([
  '-asjob',
  '-usenewrunspace',
  '-verbose',
  '-debug',
  '-whatif',
  '-confirm',
])

const START_PROCESS_VALUE_PARAMS = new Set([
  '-argumentlist',
  '-workingdirectory',
  '-verb',
  '-windowstyle',
  '-credential',
  '-redirectstandardoutput',
  '-redirectstandarderror',
  '-redirectstandardinput',
  '-environment',
  '-filepath',
])

function checkNewObject(cmd: ParsedCommandElement): Verdict | null {
  if (hasParam(cmd, '-comobject', '-com')) {
    return ASK('New-Object -ComObject requires approval.')
  }
  let checkedType = false
  for (let i = 0; i < cmd.args.length; i++) {
    const raw = cmd.args[i]!
    if (isParamToken(cmd, i)) {
      const { name, inlineValue } = splitParam(raw)
      if (name.startsWith('-t') && '-typename'.startsWith(name)) {
        checkedType = true
        if (inlineValue !== undefined) {
          const val = stripQuotes(inlineValue)
          if (!val || !isClmAllowedType(val)) {
            return ASK(`New-Object type "${val}" is not in the CLM allowlist and requires approval.`)
          }
        } else if (i + 1 < cmd.args.length) {
          i++
          const kind = argumentTypeAt(cmd, i)
          const val = stripQuotes(cmd.args[i]!)
          if ((kind !== undefined && kind !== 'StringConstant') || !isClmAllowedType(val)) {
            return ASK(`New-Object type "${val}" is not in the CLM allowlist and requires approval.`)
          }
        } else {
          return ASK('New-Object with missing type name requires approval.')
        }
      } else if (
        inlineValue === undefined &&
        name.length >= 2 &&
        ('-argumentlist'.startsWith(name) || '-property'.startsWith(name))
      ) {
        i++
      }
    } else if (!checkedType) {
      checkedType = true
      const kind = argumentTypeAt(cmd, i)
      const val = stripQuotes(raw)
      if ((kind !== undefined && kind !== 'StringConstant') || !isClmAllowedType(val)) {
        return ASK(`New-Object type "${val}" is not in the CLM allowlist and requires approval.`)
      }
    }
  }
  return null
}

function hasPositionalStringArg(cmd: ParsedCommandElement, switches: Set<string>): boolean {
  for (let i = 0; i < cmd.args.length; i++) {
    const raw = cmd.args[i]!
    if (isParamToken(cmd, i)) {
      const { name, inlineValue } = splitParam(raw)
      if (inlineValue === undefined && !switches.has(name)) {
        i++
      }
      continue
    }
    const kind = argumentTypeAt(cmd, i)
    if (kind === 'ScriptBlock') continue
    if (kind === undefined && raw.trim().startsWith('{')) continue
    return true
  }
  return false
}

function checkStartProcess(cmd: ParsedCommandElement): Verdict | null {
  let seenFilePath = false
  for (let i = 0; i < cmd.args.length; i++) {
    const raw = cmd.args[i]!
    if (isParamToken(cmd, i)) {
      const { name, inlineValue } = splitParam(raw)
      if (name === '-verb') {
        const val = inlineValue !== undefined ? stripQuotes(inlineValue) : i + 1 < cmd.args.length ? stripQuotes(cmd.args[++i]!) : ''
        if (val.toLowerCase() === 'runas') {
          return ASK('Start-Process -Verb RunAs requires approval.')
        }
      } else if (name.startsWith('-f') && '-filepath'.startsWith(name)) {
        seenFilePath = true
        const val = inlineValue !== undefined ? stripQuotes(inlineValue) : i + 1 < cmd.args.length ? stripQuotes(cmd.args[++i]!) : ''
        if (isPsExecutable(val)) {
          return ASK('Start-Process launching nested PowerShell requires approval.')
        }
      } else if (inlineValue === undefined) {
        for (const vp of START_PROCESS_VALUE_PARAMS) {
          if (name.length >= 2 && vp.startsWith(name)) {
            i++
            break
          }
        }
      }
    } else if (!seenFilePath) {
      seenFilePath = true
      if (isPsExecutable(stripQuotes(raw))) {
        return ASK('Start-Process launching nested PowerShell requires approval.')
      }
    }
  }
  return null
}

function commandHasScriptBlock(cmd: ParsedCommandElement): boolean {
  if (cmd.elementTypes?.includes('ScriptBlock')) return true
  return cmd.children?.some(list => list?.some(child => child.type === 'ScriptBlock')) ?? false
}

function checkCommandHazards(
  commands: ParsedCommandElement[],
  canonicals: string[],
): Verdict | null {
  let hasDownload = false
  let hasIex = false
  for (let i = 0; i < commands.length; i++) {
    const canonical = canonicals[i]!
    if (DOWNLOAD_CMDLETS.has(canonical)) hasDownload = true
    if (canonical === 'invoke-expression') hasIex = true
  }
  if (hasDownload && hasIex) {
    return ASK('Download-and-execute pattern (download cmdlet with Invoke-Expression) requires approval.')
  }

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    const canonical = canonicals[i]!
    const rawLower = cmd.name.toLowerCase()
    const exe = baseExeName(cmd.name)

    if (canonical === 'invoke-expression' || rawLower === 'iex') {
      return ASK('Invoke-Expression executes arbitrary strings and requires approval.')
    }

    if (
      (cmd.elementType === 'CommandAst' || cmd.elementType === 'Command') &&
      cmd.elementTypes &&
      cmd.elementTypes.length > 0 &&
      cmd.elementTypes[0] !== 'StringConstant'
    ) {
      return ASK('Dynamically computed command name requires approval.')
    }

    if (isPsExecutable(cmd.name)) {
      if (hasParam(cmd, '-encodedcommand', '-e') || hasParam(cmd, '-ec', '-ec')) {
        return ASK('Nested PowerShell with -EncodedCommand requires approval.')
      }
      return ASK('Nested PowerShell execution requires approval.')
    }

    if (canonical === 'start-bitstransfer') {
      return ASK('Start-BitsTransfer requires approval.')
    }
    if (exe === 'certutil' && hasParam(cmd, '-urlcache', '-urlcache')) {
      return ASK('certutil -urlcache requires approval.')
    }
    if (exe === 'bitsadmin' && hasParam(cmd, '-transfer', '-transfer')) {
      return ASK('bitsadmin /transfer requires approval.')
    }

    if (canonical === 'add-type') {
      return ASK('Add-Type compiles or loads .NET code and requires approval.')
    }

    if (canonical === 'new-object') {
      const verdict = checkNewObject(cmd)
      if (verdict) return verdict
    }

    if (FILEPATH_EXECUTION_CMDLETS.has(canonical)) {
      if (
        hasParam(cmd, '-filepath', '-f') ||
        hasParam(cmd, '-literalpath', '-lit') ||
        hasPositionalStringArg(cmd, FILEPATH_CMDLET_SWITCHES)
      ) {
        return ASK(`${cmd.name} executing a script file requires approval.`)
      }
    }

    if (canonical === 'invoke-item') {
      return ASK('Invoke-Item requires approval.')
    }

    if (SCHEDULED_TASK_CMDLETS.has(canonical)) {
      return ASK('Scheduled task creation or modification requires approval.')
    }
    if (exe === 'schtasks' && (hasParam(cmd, '-create', '-create') || hasParam(cmd, '-change', '-change'))) {
      return ASK('schtasks /create or /change requires approval.')
    }

    if (canonical === 'foreach-object') {
      if (hasParam(cmd, '-membername', '-m') || hasPositionalStringArg(cmd, FOREACH_SWITCHES)) {
        return ASK('ForEach-Object invoking a method by name requires approval.')
      }
    }

    if (canonical === 'start-process') {
      const verdict = checkStartProcess(cmd)
      if (verdict) return verdict
    }
  }
  return null
}

export function powershellCommandIsSafe(_command: string, parsed: ParsedPowerShellCommand): Verdict {
  if (!parsed.valid) {
    return ASK('PowerShell command could not be parsed safely.')
  }

  const commands = getAllCommands(parsed)
  const canonicals = commands.map(cmd => resolveToCanonical(cmd.name))

  const commandHazard = checkCommandHazards(commands, canonicals)
  if (commandHazard) return commandHazard

  const flags = deriveSecurityFlags(parsed)

  if (flags.hasScriptBlocks) {
    let anyCarrier = false
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      const canonical = canonicals[i]!
      if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(canonical)) {
        return ASK(`Script block with ${cmd.name} requires approval.`)
      }
      if (commandHasScriptBlock(cmd)) {
        anyCarrier = true
        if (!SAFE_SCRIPT_BLOCK_CMDLETS.has(canonical)) {
          return ASK(`Script block passed to ${cmd.name} requires approval.`)
        }
      }
    }
    for (const stmt of parsed.statements) {
      for (const nested of stmt.nestedCommands) {
        const canonical = resolveToCanonical(nested.name)
        if (!SAFE_SCRIPT_BLOCK_CMDLETS.has(canonical)) {
          return ASK(`Script block containing ${nested.name} requires approval.`)
        }
      }
    }
    if (!anyCarrier) {
      return ASK('Script block requires approval.')
    }
  }

  if (flags.hasSubExpressions) {
    return ASK('Sub-expressions require approval.')
  }
  if (flags.hasExpandableStrings) {
    return ASK('Expandable strings require approval.')
  }
  if (flags.hasSplatting) {
    return ASK('Variable splatting requires approval.')
  }
  if (flags.hasStopParsing) {
    return ASK('Stop-parsing token (--%) requires approval.')
  }
  if (flags.hasMemberInvocations) {
    return ASK('.NET member invocations require approval.')
  }

  for (const typeName of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(typeName)) {
      return ASK(`Type literal [${typeName}] is not in the CLM allowlist and requires approval.`)
    }
  }

  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length > 0) {
    if (flags.hasAssignments) {
      return ASK('Modifying environment variables requires approval.')
    }
    if (canonicals.some(c => ENV_WRITING_CMDLETS.has(c))) {
      return ASK('Modifying environment variables requires approval.')
    }
  }
  for (let i = 0; i < commands.length; i++) {
    const canonical = canonicals[i]!
    if (ENV_WRITING_CMDLETS.has(canonical) && commands[i]!.args.some(a => /^env:/i.test(stripQuotes(a)))) {
      return ASK('Modifying environment variables requires approval.')
    }
  }

  for (let i = 0; i < commands.length; i++) {
    const canonical = canonicals[i]!
    const rawLower = commands[i]!.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(canonical) || MODULE_LOADING_CMDLETS.has(rawLower)) {
      return ASK('Loading or installing PowerShell modules requires approval.')
    }
    if (STATE_MUTATION_CMDLETS.has(canonical) || STATE_MUTATION_CMDLETS.has(rawLower)) {
      return ASK('Mutating PowerShell aliases or variables requires approval.')
    }
    if (WMI_CIM_CMDLETS.has(canonical) || WMI_CIM_CMDLETS.has(rawLower)) {
      return ASK('WMI/CIM method invocation requires approval.')
    }
  }

  return PASS
}
