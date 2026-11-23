import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate, PermissionRule } from '../../types/permissions.js'
import {
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../utils/powershell/parser.js'
import {
  allWorkingDirectories,
  checkUncPathPermission,
  checkEditableInternalPath,
  checkReadableInternalPath,
  checkPathSafetyForAutoEdit,
  envFileReadAsk,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import { expandTilde, formatDirectoryList, isDangerousRemovalPath } from '../../utils/permissions/pathValidation.js'
import { createEditRuleSuggestion, createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { getFsImplementation, safeResolvePath } from '../../utils/fsOperations.js'
import { getShellCwd } from '../../utils/Shell.js'
import { getPlatform } from '../../utils/platform.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../utils/permissions/windowsPath.js'
import { resolveToCanonical } from './readOnlyValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'

type OperationType = 'read' | 'write'
const STD = ['-path', '-literalpath', '-pspath', '-lp']
const PS_DASH_RE = /[-–—―]/

type PathConfig = {
  operation: OperationType
  paths: string[]
  leafOnly?: string[]
  switches: string[]
  values: string[]
  positionalSkip?: number
  optionalWrite?: boolean
}

const IWR_SWITCHES = '-allowinsecureredirect -allowunencryptedauthentication -disablekeepalive -nobodyprogress -passthru -preservefileauthorizationmetadata -resume -skipcertificatecheck -skipheadervalidation -skiphttperrorcheck -usebasicparsing -usedefaultcredentials'.split(' ')
const IWR_VALUES = '-uri -method -body -contenttype -headers -maximumredirection -maximumretrycount -proxy -proxycredential -retryintervalsec -sessionvariable -timeoutsec -token -transferencoding -useragent -websession -credential -authentication -certificate -certificatethumbprint -form -httpversion'.split(' ')

const PATH_CONFIG: Record<string, PathConfig> = {
  'set-content': w(STD, '-passthru -force -whatif -confirm -usetransaction -nonewline -asbytestream', '-value -filter -include -exclude -credential -encoding -stream'),
  'add-content': w(STD, '-passthru -force -whatif -confirm -usetransaction -nonewline -asbytestream', '-value -filter -include -exclude -credential -encoding -stream'),
  'remove-item': w(STD, '-recurse -force -whatif -confirm -usetransaction', '-filter -include -exclude -credential -stream'),
  'clear-content': w(STD, '-force -whatif -confirm -usetransaction', '-filter -include -exclude -credential -stream'),
  'out-file': w(['-filepath', ...STD], '-append -force -noclobber -nonewline -whatif -confirm', '-inputobject -encoding -width'),
  'tee-object': w(['-filepath', ...STD], '-append', '-inputobject -variable -encoding'),
  'export-csv': w(STD, '-append -force -noclobber -notypeinformation -includetypeinformation -useculture -noheader -whatif -confirm', '-inputobject -delimiter -encoding -quotefields -usequotes'),
  'export-clixml': w(STD, '-force -noclobber -whatif -confirm', '-inputobject -depth -encoding'),
  'new-item': { ...w(STD, '-force -whatif -confirm -usetransaction', '-itemtype -value -credential -type'), leafOnly: ['-name'] },
  'copy-item': w([...STD, '-destination'], '-container -force -passthru -recurse -whatif -confirm -usetransaction', '-filter -include -exclude -credential -fromsession -tosession'),
  'move-item': w([...STD, '-destination'], '-force -passthru -whatif -confirm -usetransaction', '-filter -include -exclude -credential'),
  'rename-item': w(STD, '-force -passthru -whatif -confirm -usetransaction', '-newname -credential -filter -include -exclude'),
  'set-item': w(STD, '-force -passthru -whatif -confirm -usetransaction', '-value -credential -filter -include -exclude'),
  'set-itemproperty': w(STD, '-passthru -force -whatif -confirm -usetransaction', '-name -value -type -filter -include -exclude -credential -inputobject'),
  'new-itemproperty': w(STD, '-force -whatif -confirm -usetransaction', '-name -value -propertytype -type -filter -include -exclude -credential'),
  'remove-itemproperty': w(STD, '-force -whatif -confirm -usetransaction', '-name -filter -include -exclude -credential'),
  'clear-item': w(STD, '-force -whatif -confirm -usetransaction', '-filter -include -exclude -credential'),
  'export-alias': w(STD, '-append -force -noclobber -passthru -whatif -confirm', '-name -description -scope -as'),
  'expand-archive': w([...STD, '-destinationpath'], '-force -passthru -whatif -confirm', ''),
  'compress-archive': w([...STD, '-destinationpath'], '-force -update -passthru -whatif -confirm', '-compressionlevel'),
  'invoke-webrequest': { operation: 'write', paths: ['-outfile', '-infile'], switches: IWR_SWITCHES, values: IWR_VALUES, positionalSkip: 1, optionalWrite: true },
  'invoke-restmethod': { operation: 'write', paths: ['-outfile', '-infile'], switches: [...IWR_SWITCHES, '-followrellink'], values: [...IWR_VALUES, '-maximumfollowrellink', '-responseheadersvariable', '-statuscodevariable'], positionalSkip: 1, optionalWrite: true },
  'get-content': r(STD, '-force -usetransaction -wait -raw -asbytestream', '-readcount -totalcount -tail -first -head -last -filter -include -exclude -credential -delimiter -encoding -stream'),
  'get-childitem': r(STD, '-recurse -force -name -usetransaction -followsymlink -directory -file -hidden -readonly -system', '-filter -include -exclude -depth -attributes -credential'),
  'get-item': r(STD, '-force -usetransaction', '-filter -include -exclude -credential -stream'),
  'get-itemproperty': r(STD, '-usetransaction', '-name -filter -include -exclude -credential'),
  'get-itempropertyvalue': r(STD, '-usetransaction', '-name -filter -include -exclude -credential'),
  'get-filehash': r(STD, '', '-algorithm -inputstream'),
  'get-acl': r(STD, '-audit -allcentralaccesspolicies -usetransaction', '-inputobject -filter -include -exclude'),
  'format-hex': r(STD, '-raw', '-inputobject -encoding -count -offset'),
  'test-path': r(STD, '-isvalid -usetransaction', '-filter -include -exclude -pathtype -credential -olderthan -newerthan'),
  'resolve-path': r(STD, '-relative -usetransaction -force', '-credential -relativebasepath'),
  'convert-path': r(STD, '-usetransaction', ''),
  'select-string': r(STD, '-simplematch -casesensitive -quiet -list -notmatch -allmatches -noemphasis -raw', '-inputobject -pattern -include -exclude -encoding -context -culture'),
  'set-location': r(STD, '-passthru -usetransaction', '-stackname'),
  'push-location': r(STD, '-passthru -usetransaction', '-stackname'),
  'pop-location': r([], '-passthru -usetransaction', '-stackname'),
  'select-xml': r(STD, '', '-xml -content -xpath -namespace'),
  'get-winevent': r(['-path'], '-force -oldest', '-listlog -logname -listprovider -providername -maxevents -computername -credential -filterxpath -filterxml -filterhashtable'),
}

function w(paths: string[], sw: string, val: string): PathConfig {
  return { operation: 'write', paths, switches: sw ? sw.split(' ') : [], values: val ? val.split(' ') : [] }
}
function r(paths: string[], sw: string, val: string): PathConfig {
  return { operation: 'read', paths, switches: sw ? sw.split(' ') : [], values: val ? val.split(' ') : [] }
}

const REMOVAL_CANONICAL = 'remove-item'
const ENV_CONTENT_CMDLETS = new Set(['get-content', 'select-string', 'format-hex', 'select-xml', 'copy-item', 'move-item'])

function isComplexColonValue(value: string): boolean {
  return value.includes(',') || value.startsWith('(') || value.startsWith('[') || value.startsWith('@{') || value.includes('`') || value.includes('@(') || value.includes('$')
}


type ExtractResult = { paths: string[]; operation: OperationType; unvalidatable: boolean; optionalWrite: boolean; hasConfig: boolean }

type ParamCategory = 'path' | 'leaf' | 'switch' | 'value'

function isCommonSwitch(name: string): boolean {
  return name === '-verbose' || name === '-debug'
}

function matchParameterCategory(name: string, config: PathConfig): ParamCategory | null {
  if (config.paths.includes(name)) return 'path'
  if (config.leafOnly?.includes(name)) return 'leaf'
  if (config.switches.includes(name) || isCommonSwitch(name)) return 'switch'
  if (config.values.includes(name) || COMMON_PARAMETERS.has(name)) return 'value'
  if (name.length < 2) return null

  const candidates: Array<{ param: string; category: ParamCategory }> = []
  for (const p of config.paths) candidates.push({ param: p, category: 'path' })
  if (config.leafOnly) {
    for (const p of config.leafOnly) candidates.push({ param: p, category: 'leaf' })
  }
  for (const p of config.switches) candidates.push({ param: p, category: 'switch' })
  for (const p of config.values) candidates.push({ param: p, category: 'value' })
  for (const p of COMMON_PARAMETERS) {
    candidates.push({ param: p, category: isCommonSwitch(p) ? 'switch' : 'value' })
  }

  const seen = new Map<string, ParamCategory>()
  for (const c of candidates) {
    if (c.param.startsWith(name) && !seen.has(c.param)) {
      seen.set(c.param, c.category)
    }
  }
  if (seen.size !== 1) return null
  return seen.values().next().value ?? null
}

function isStaticElementType(type: ReturnType<typeof argumentTypeAt>): boolean {
  return type === undefined || type === 'StringConstant' || type === 'Parameter'
}

function isUnsafeLeafName(raw: string): boolean {
  let v = raw
  if (/^['"]/.test(v)) v = v.slice(1)
  if (/['"]$/.test(v)) v = v.slice(0, -1)
  return v.includes('/') || v.includes('\\') || v === '.' || v === '..'
}

function extractPaths(element: ParsedCommandElement): ExtractResult {
  const canonical = resolveToCanonical(element.name)
  const config = PATH_CONFIG[canonical]
  if (!config) {
    return { paths: [], operation: 'read', unvalidatable: false, optionalWrite: false, hasConfig: false }
  }

  const paths: string[] = []
  let unvalidatable = false
  let positionalSeen = 0
  const skip = config.positionalSkip ?? 0

  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i]!
    const argType = argumentTypeAt(element, i)
    if (isPowerShellParameter(arg, argType)) {
      const normed = normDash(arg)
      const colon = normed.indexOf(':', 1)
      const rawName = (colon === -1 ? normed : normed.slice(0, colon)).toLowerCase()
      const colonValue = colon === -1 ? undefined : normed.slice(colon + 1)
      const category = matchParameterCategory(rawName, config)

      if (category === null) {
        unvalidatable = true
        continue
      }
      if (category === 'switch') {
        continue
      }
      if (category === 'path') {
        if (colonValue !== undefined) {
          const childType = element.children?.[i]?.[0]?.type
          if (colonValue === '' || isComplexColonValue(colonValue) || !isStaticElementType(childType)) {
            unvalidatable = true
          } else {
            paths.push(colonValue)
          }
        } else if (i + 1 < element.args.length) {
          const nextArg = element.args[i + 1]!
          const nextType = argumentTypeAt(element, i + 1)
          if (isPowerShellParameter(nextArg, nextType)) {
            unvalidatable = true
          } else {
            i++
            if (isStaticElementType(nextType)) {
              paths.push(nextArg)
            } else {
              unvalidatable = true
            }
          }
        } else {
          unvalidatable = true
        }
        continue
      }
      if (category === 'leaf') {
        if (colonValue !== undefined) {
          const childType = element.children?.[i]?.[0]?.type
          if (colonValue === '' || isComplexColonValue(colonValue) || !isStaticElementType(childType) || isUnsafeLeafName(colonValue)) {
            unvalidatable = true
          }
        } else if (i + 1 < element.args.length) {
          const nextArg = element.args[i + 1]!
          const nextType = argumentTypeAt(element, i + 1)
          if (isPowerShellParameter(nextArg, nextType)) {
            unvalidatable = true
          } else {
            i++
            if (!isStaticElementType(nextType) || isUnsafeLeafName(nextArg)) {
              unvalidatable = true
            }
          }
        } else {
          unvalidatable = true
        }
        continue
      }
      if (category === 'value') {
        if (colonValue !== undefined) {
          if (isComplexColonValue(colonValue)) unvalidatable = true
        } else if (i + 1 < element.args.length) {
          const nextArg = element.args[i + 1]!
          const nextType = argumentTypeAt(element, i + 1)
          if (!isPowerShellParameter(nextArg, nextType)) {
            i++
            if (!isStaticElementType(nextType)) unvalidatable = true
          }
        }
        continue
      }
    }

    positionalSeen++
    if (config.paths.length === 0 || positionalSeen <= skip) continue
    if (isStaticElementType(argType)) {
      paths.push(arg)
    } else {
      unvalidatable = true
    }
  }

  return {
    paths,
    operation: config.operation,
    unvalidatable,
    optionalWrite: config.optionalWrite ?? false,
    hasConfig: true,
  }
}

function normDash(arg: string): string {
  return PS_DASH_RE.test(arg[0] ?? '') ? '-' + arg.slice(1) : arg
}


type ResolveResult = { allowed: boolean; resolvedPath: string; reason?: PermissionDecisionReason }

function resolveAndDecide(rawPath: string, cwd: string, context: ToolPermissionContext, operation: OperationType): ResolveResult {
  let path = rawPath
  if (/^['"]/.test(path)) path = path.slice(1)
  if (/['"]$/.test(path)) path = path.slice(0, -1)
  path = expandTilde(path)
  const remote = checkUncPathPermission(path, context, operation === 'read' ? 'read' : 'edit')
  if (remote) return {
    allowed: remote.behavior === 'allow', resolvedPath: path,
    reason: remote.behavior === 'ask' && remote.decisionReason?.type === 'rule'
      ? { type: 'safetyCheck', reason: remote.message, operatorOnly: true } : remote.decisionReason,
  }
  path = path.replace(/\\/g, '/')

  if (path.includes('`')) return notAllowed(path, other('A backtick escape cannot be statically validated.'))
  if (path.includes('::')) {
    const stripped = path.slice(path.indexOf('::') + 2)
    return notAllowed(stripped, other('A module-qualified provider path cannot be statically validated.'))
  }
  if (containsWindowsDevicePath(path)) return notAllowed(path, other(WINDOWS_DEVICE_PATH_MESSAGE))
  if (path.includes('$') || path.includes('%')) return notAllowed(path, other('Variable-expansion syntax requires manual approval.'))
  const drivePrefix = getPlatform() === 'windows' ? /^[A-Za-z0-9]{2,}:/ : /^[A-Za-z0-9]+:/
  if (drivePrefix.test(path)) return notAllowed(path, other(`The path ${path} uses a non-filesystem provider.`))
  if (/[*?[\]]/.test(path)) {
    if (operation !== 'read') return notAllowed(path, other('Globs are not allowed in write operations; provide an exact path.'))
    const base = path.slice(0, path.search(/[*?[\]]/)).replace(/\/[^/]*$/, '') || '.'
    const resolved = resolveOperandPath(base, cwd)
    const deny = matchDeny(resolved, context, 'read')
    if (deny) return notAllowed(resolved, { type: 'rule', rule: deny })
    return notAllowed(resolved, other('A glob cannot be statically validated because symlinks inside the expansion are not examined.'))
  }
  const resolved = safeResolvePath(getFsImplementation(), resolveOperandPath(path, cwd)).resolvedPath
  return decideResolved(resolved, context, operation)
}

function decideResolved(resolved: string, context: ToolPermissionContext, operation: OperationType): ResolveResult {
  const permType = operation === 'read' ? 'read' : 'edit'
  const deny = matchDeny(resolved, context, permType)
  if (deny) return notAllowed(resolved, { type: 'rule', rule: deny })

  if (operation === 'write') {
    if (checkEditableInternalPath(resolved).behavior === 'allow') {
      return { allowed: true, resolvedPath: resolved }
    }
    const safety = checkPathSafetyForAutoEdit(resolved, undefined, context)
    if (!safety.safe) {
      return notAllowed(resolved, { type: 'safetyCheck', reason: safety.message, operatorOnly: safety.operatorOnly })
    }
  }

  if (pathInAllowedWorkingPath(resolved, context)) {
    if (operation === 'read' || context.mode === 'implement') {
      return { allowed: true, resolvedPath: resolved }
    }
  }

  if (operation === 'read' && checkReadableInternalPath(resolved).behavior === 'allow') {
    return { allowed: true, resolvedPath: resolved }
  }

  const allow = matchingRuleForInput(resolved, context, permType, 'allow')
  if (allow) return { allowed: true, resolvedPath: resolved }

  return { allowed: false, resolvedPath: resolved }
}

function matchDeny(path: string, context: ToolPermissionContext, permType: 'read' | 'edit'): PermissionRule | null {
  return matchingRuleForInput(path, context, permType, 'deny')
}

const DRIVE_QUALIFIED = /^[A-Za-z]:\//

export function resolveOperandPath(path: string, cwd: string): string {
  if (path.startsWith('/') || DRIVE_QUALIFIED.test(path)) return path
  return `${cwd}/${path}`
}


function notAllowed(resolvedPath: string, reason: PermissionDecisionReason): ResolveResult {
  return { allowed: false, resolvedPath, reason }
}
function other(reason: string): PermissionDecisionReason {
  return { type: 'other', reason }
}


export function isDangerousRemovalRawPath(path: string): boolean {
  let p = path
  if (/^['"]/.test(p)) p = p.slice(1)
  if (/['"]$/.test(p)) p = p.slice(0, -1)
  p = expandTilde(p).replace(/\\/g, '/')
  return isDangerousRemovalPath(p)
}

export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Remove-Item of "${path}" is refused: this location is under blanket protection against deletion and cannot be approved.`,
    decisionReason: other(`Dangerous removal of a protected path: ${path}`),
  }
}

export function checkPowerShellCwd(cwd: string, context: ToolPermissionContext): PermissionResult | null {
  const decision = resolveAndDecide(cwd, getShellCwd(), context, 'read')
  if (decision.allowed) return null
  if (decision.reason?.type === 'rule') {
    return { behavior: 'deny', message: pathMessage('set-location', decision, context), decisionReason: decision.reason }
  }
  return askForPath('set-location', decision, 'read', context)
}

export function checkPathConstraints(
  _input: { command: string },
  parsed: ParsedPowerShellCommand,
  context: ToolPermissionContext,
  compoundCommandHasCd = false,
  cwd = getShellCwd(),
): PermissionResult {
  if (!parsed.valid) {
    return { behavior: 'passthrough', message: 'Parsed PowerShell AST is not valid.' }
  }

  let firstAsk: PermissionResult | null = null
  for (const statement of getPipelineSegments(parsed)) {
    if (compoundCommandHasCd) {
      const msg = 'This compound changes the working directory (Set-Location / Push-Location / Pop-Location / New-PSDrive), so relative paths cannot be validated against the original working directory.'
      firstAsk ??= { behavior: 'ask', message: msg, decisionReason: other(msg) }
    }

    for (const cmd of statement.commands) {
      const verdict = checkOneCommand(cmd, cwd, context)
      if (!verdict) continue
      if (verdict.behavior === 'deny') return verdict
      if (verdict.behavior === 'ask') firstAsk ??= verdict
    }

    for (const cmd of statement.nestedCommands) {
      const verdict = checkOneCommand(cmd, cwd, context)
      if (!verdict) continue
      if (verdict.behavior === 'deny') return verdict
      if (verdict.behavior === 'ask') firstAsk ??= verdict
    }

    for (const redir of statement.redirections) {
      if (redir.isMerging || isNullRedirectionTarget(redir.target)) continue
      const decision = resolveAndDecide(redir.target, cwd, context, 'write')
      if (!decision.allowed) {
        const message = redirMessage(decision, context)
        if (decision.reason?.type === 'rule') {
          return { behavior: 'deny', message, decisionReason: decision.reason }
        }
        firstAsk ??= {
          behavior: 'ask',
          message,
          decisionReason: decision.reason ?? { type: 'workingDir', reason: message },
          ...(decision.resolvedPath
            ? {
                suggestions: [
                  editGrant(decision.resolvedPath),
                  { type: 'setMode', destination: 'session', mode: 'implement' },
                ],
              }
            : {}),
        }
      }
    }
  }

  if (firstAsk) return firstAsk
  return { behavior: 'passthrough', message: 'All PowerShell paths passed validation.' }
}

function checkOneCommand(command: ParsedCommandElement, cwd: string, context: ToolPermissionContext): PermissionResult | null {
  const extracted = extractPaths(command)
  const canonical = resolveToCanonical(command.name)
  if (extracted.operation !== 'read' && !extracted.optionalWrite && extracted.paths.length === 0 && extracted.hasConfig) {
    return { behavior: 'ask', message: `${canonical} has no determinable write target.`, decisionReason: other('A write operation with no target.') }
  }
  let firstAsk: PermissionResult | null = null
  for (const rawPath of extracted.paths) {
    if (canonical === REMOVAL_CANONICAL && isDangerousRemovalRawPath(rawPath)) return dangerousRemovalDeny(rawPath)
    const decision = resolveAndDecide(rawPath, cwd, context, extracted.operation)
    if (canonical === REMOVAL_CANONICAL && isDangerousRemovalRawPath(decision.resolvedPath)) return dangerousRemovalDeny(decision.resolvedPath)
    if (!decision.allowed) {
      if (decision.reason?.type === 'rule') return { behavior: 'deny', message: pathMessage(canonical, decision, context), decisionReason: decision.reason }
      firstAsk ??= askForPath(canonical, decision, extracted.operation, context)
      continue
    }
    const envAsk = ENV_CONTENT_CMDLETS.has(canonical) ? envFileReadAsk(decision.resolvedPath, context) : null
    if (envAsk) firstAsk ??= { behavior: 'ask', message: envAsk.message, decisionReason: envAsk.decisionReason }
  }
  if (firstAsk) return firstAsk
  if (extracted.unvalidatable) {
    return { behavior: 'ask', message: `${canonical} has an argument (array literal, sub-expression, or unrecognised parameter) beyond static checking.`, decisionReason: other('An unvalidatable path argument.') }
  }
  return null
}


function askForPath(canonical: string, decision: ResolveResult, operation: OperationType, context: ToolPermissionContext): PermissionResult {
  const message = pathMessage(canonical, decision, context)
  const suggestions: PermissionUpdate[] = []
  if (decision.resolvedPath) {
    if (operation === 'read') {
      const suggestion = createReadRuleSuggestion(getDirectoryForPath(decision.resolvedPath))
      if (suggestion) suggestions.push(suggestion)
    } else {
      suggestions.push(editGrant(decision.resolvedPath))
      suggestions.push({ type: 'setMode', destination: 'session', mode: 'implement' })
    }
  }
  return {
    behavior: 'ask',
    message,
    decisionReason: decision.reason ?? { type: 'workingDir', reason: message },
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }
}

function editGrant(resolvedPath: string): PermissionUpdate {
  return createEditRuleSuggestion(getDirectoryForPath(resolvedPath)) ?? {
    type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: `/${resolvedPath.replace(/\\/g, '/')}` }], behavior: 'allow', destination: 'session',
  }
}

function pathMessage(canonical: string, decision: ResolveResult, context: ToolPermissionContext): string {
  if (decision.reason && (decision.reason.type === 'other' || decision.reason.type === 'safetyCheck')) return decision.reason.reason
  return `${canonical} needs permission for ${decision.resolvedPath}. The starting folder is ${formatDirs(context)}.`
}
function redirMessage(decision: ResolveResult, context: ToolPermissionContext): string {
  if (decision.reason && (decision.reason.type === 'other' || decision.reason.type === 'safetyCheck')) return decision.reason.reason
  return `Writing the redirection target ${decision.resolvedPath} needs permission. The starting folder is ${formatDirs(context)}.`
}
function formatDirs(context: ToolPermissionContext): string {
  return formatDirectoryList([...allWorkingDirectories(context)])
}
