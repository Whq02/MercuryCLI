/**
 * PowerShell path validation: extract the filesystem operands and redirection
 * targets a parsed command touches, and decide deny/ask/passthrough against the
 * session's allowed working directories. Two-pass over statements: the first
 * deny wins immediately; the first ask is remembered and returned only after
 * every statement has been checked (an early ask would let a user approve a
 * command that also contains a denied path).
 */
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate, PermissionRule } from '../../types/permissions.js'
import {
  getPipelineSegments,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  allWorkingDirectories,
  checkEditableInternalPath,
  checkReadableInternalPath,
  checkPathSafetyForAutoEdit,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import { expandTilde, isDangerousRemovalPath, isPathInSandboxWriteAllowlist } from '../../utils/permissions/pathValidation.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { getFsImplementation, safeResolvePath } from '../../utils/fsOperations.js'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { resolveToCanonical } from './readOnlyValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'

type OperationType = 'read' | 'write'
const STD = ['-path', '-literalpath', '-pspath', '-lp']
const PS_DASH_RE = /[-–—―]/

/** A per-cmdlet path configuration. */
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

/** The per-cmdlet path configuration table (contract data). Ordinary object (inherits member names — fail-safe). */
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
  'invoke-restmethod': { operation: 'write', paths: ['-outfile', '-infile'], switches: [...IWR_SWITCHES, '-followrellink'], values: [...IWR_VALUES, '-maximumfollowrellink', '-responseheaderstvariable', '-statuscodevariable'], positionalSkip: 1, optionalWrite: true },
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
const OPTIONAL_WRITE = new Set(['invoke-webrequest', 'invoke-restmethod'])

/** A complex colon value hides a runtime path. */
function isComplexColonValue(value: string): boolean {
  return value.includes(',') || value.startsWith('(') || value.startsWith('[') || value.startsWith('@{') || value.includes('`') || value.includes('@(') || value.includes('$')
}

// ── path extraction ────────────────────────────────────────────────────────

type ExtractResult = { paths: string[]; operation: OperationType; unvalidatable: boolean; optionalWrite: boolean; hasConfig: boolean }

/** Extract validatable path operands from a command element. */
function extractPaths(element: ParsedCommandElement): ExtractResult {
  const canonical = resolveToCanonical(element.name)
  const config = PATH_CONFIG[canonical]
  if (!config || typeof config !== 'object' || !('operation' in config)) {
    return { paths: [], operation: 'read', unvalidatable: false, optionalWrite: false, hasConfig: false }
  }
  const known = new Set<string>([...config.paths, ...(config.leafOnly ?? []), ...config.switches, ...config.values, ...COMMON_PARAMETERS])
  const matchesKnown = (name: string): string | null => {
    const lower = name.toLowerCase()
    for (const k of known) {
      if (lower === k) return k
      if (lower.length > 1 && k.startsWith(lower)) return k
    }
    return null
  }
  const isPathParam = (k: string): boolean => config.paths.includes(k)
  const isLeafParam = (k: string): boolean => (config.leafOnly ?? []).includes(k)
  const isSwitch = (k: string): boolean => config.switches.includes(k)
  const isValueParam = (k: string): boolean => config.values.includes(k) || COMMON_PARAMETERS.has(k)

  const paths: string[] = []
  let unvalidatable = false
  const types = element.elementTypes
  const safeType = (i: number): boolean => !types || types[i] === 'StringConstant' || types[i] === 'Parameter'
  let positionalSeen = 0
  const skip = config.positionalSkip ?? 0

  for (let i = 0; i < element.args.length; i++) {
    const raw = element.args[i] as string
    const isParam = types ? types[i] === 'Parameter' : isPowerShellParameter(raw)
    if (isParam) {
      const norm = normDash(raw)
      const colon = norm.indexOf(':', 1)
      const pname = (colon === -1 ? norm : norm.slice(0, colon)).toLowerCase()
      const matched = matchesKnown(pname)
      if (matched && isPathParam(matched)) {
        const value = colon !== -1 ? norm.slice(colon + 1) : element.args[i + 1]
        if (colon !== -1) {
          if (!isComplexColonValue(value as string)) paths.push(value as string)
          else unvalidatable = true
        } else if (value !== undefined && !isPowerShellParameter(value)) {
          if (safeType(i + 1)) paths.push(value)
          else unvalidatable = true
          i++
        }
      } else if (matched && isLeafParam(matched)) {
        const value = colon !== -1 ? norm.slice(colon + 1) : element.args[i + 1]
        if (value !== undefined) {
          const v = value as string
          if (v.includes('/') || v.includes('\\') || v === '.' || v === '..') unvalidatable = true
          else paths.push(v)
          if (colon === -1) i++
        }
      } else if (matched && isSwitch(matched)) {
        // consumes nothing
      } else if (matched && isValueParam(matched)) {
        const value = colon !== -1 ? norm.slice(colon + 1) : element.args[i + 1]
        if (colon === -1 && value !== undefined) {
          if (!safeType(i + 1)) unvalidatable = true
          i++
        } else if (colon !== -1 && isComplexColonValue(value as string)) unvalidatable = true
      } else {
        // Unknown parameter → unvalidatable; still push a colon-bound simple value for deny checks.
        unvalidatable = true
        if (colon !== -1 && !isComplexColonValue(norm.slice(colon + 1))) paths.push(norm.slice(colon + 1))
      }
    } else {
      if (positionalSeen < skip) { positionalSeen++; continue }
      positionalSeen++
      if (safeType(i)) paths.push(raw)
      else unvalidatable = true
    }
  }
  return { paths, operation: config.operation, unvalidatable, optionalWrite: config.optionalWrite === true, hasConfig: true }
}

function normDash(arg: string): string {
  return PS_DASH_RE.test(arg[0] ?? '') ? '-' + arg.slice(1) : arg
}

// ── path resolution + allow decision ──────────────────────────────────────

type ResolveResult = { allowed: boolean; resolvedPath: string; reason?: PermissionDecisionReason }

/** Resolve one extracted path and decide whether it is permitted. */
function resolveAndDecide(rawPath: string, cwd: string, context: ToolPermissionContext, operation: OperationType): ResolveResult {
  let path = rawPath
  if (/^['"]/.test(path)) path = path.slice(1)
  if (/['"]$/.test(path)) path = path.slice(0, -1)
  path = expandTilde(path)
  path = path.replace(/\\/g, '/') // normalise before resolution

  if (path.includes('`')) return notAllowed(path, other('A backtick escape cannot be statically validated.'))
  if (path.includes('::')) {
    const stripped = path.slice(path.indexOf('::') + 2)
    return notAllowed(stripped, other('A module-qualified provider path cannot be statically validated.'))
  }
  if (path.startsWith('//') || /davwwwroot|@ssl@/i.test(path)) return notAllowed(path, other('A UNC path may trigger network requests and leak credentials.'))
  if (path.includes('$') || path.includes('%')) return notAllowed(path, other('Variable-expansion syntax requires manual approval.'))
  const drivePrefix = getPlatform() === 'windows' ? /^[A-Za-z0-9]{2,}:/ : /^[A-Za-z0-9]+:/
  if (drivePrefix.test(path)) return notAllowed(path, other(`The path ${path} uses a non-filesystem provider.`))
  if (/[*?[\]]/.test(path)) {
    if (operation !== 'read') return notAllowed(path, other('Globs are not allowed in write operations; provide an exact path.'))
    // read glob handling: deny-only base-directory check (simplified — resolve base).
    const base = path.slice(0, path.search(/[*?[\]]/)).replace(/\/[^/]*$/, '') || '.'
    const resolved = resolveOperandPath(base, cwd)
    const deny = matchDeny(resolved, context, 'read')
    if (deny) return notAllowed(resolved, { type: 'rule', rule: deny })
    return notAllowed(resolved, other('A glob cannot be statically validated because symlinks inside the expansion are not examined.'))
  }
  const resolved = canonicalise(resolveOperandPath(path, cwd))
  return decideResolved(resolved, context, operation)
}

/** Decide whether a canonical path is permitted (the ordered check). */
function decideResolved(resolved: string, context: ToolPermissionContext, operation: OperationType): ResolveResult {
  const permType = operation === 'read' ? 'read' : 'edit'
  const deny = matchDeny(resolved, context, permType)
  if (deny) return { allowed: false, resolvedPath: resolved, reason: { type: 'rule', rule: deny } }
  if (operation !== 'read') {
    const editable = checkEditableInternalPath(resolved, {})
    if (editable.behavior === 'allow') return { allowed: true, resolvedPath: resolved, reason: editable.decisionReason }
    const safety = checkPathSafetyForAutoEdit(resolved)
    if (!safety.safe) return { allowed: false, resolvedPath: resolved, reason: { type: 'safetyCheck', reason: safety.message, classifierApprovable: safety.classifierApprovable } }
  }
  const inside = pathInAllowedWorkingPath(resolved, context)
  if (inside) {
    if (operation === 'read') return { allowed: true, resolvedPath: resolved }
    if (context.mode === 'implement') return { allowed: true, resolvedPath: resolved }
  }
  if (operation === 'read') {
    const readable = checkReadableInternalPath(resolved, {})
    if (readable.behavior === 'allow') return { allowed: true, resolvedPath: resolved, reason: readable.decisionReason }
  }
  if (operation !== 'read' && !inside && isPathInSandboxWriteAllowlist(resolved)) {
    return { allowed: true, resolvedPath: resolved, reason: other('The path is in the sandbox write allowlist.') }
  }
  const allow = matchingRuleForInput(resolved, context, permType, 'allow')
  if (allow) return { allowed: true, resolvedPath: resolved, reason: { type: 'rule', rule: allow } }
  return { allowed: false, resolvedPath: resolved }
}

function matchDeny(path: string, context: ToolPermissionContext, permType: 'read' | 'edit'): PermissionRule | null {
  return matchingRuleForInput(path, context, permType, 'deny')
}

/** A drive-qualified spelling in the separator-normalised form the callers
 *  hand in (C:/…). */
const DRIVE_QUALIFIED = /^[A-Za-z]:\//

/**
 * Resolve one operand against the session directory. The operand was
 * separator-normalised to forward slashes by the caller, so an absolute
 * spelling is POSIX-rooted or drive-qualified; only a relative one joins the
 * session directory. Concatenating a drive-qualified operand
 * (C:\proj/C:/Users/Public/notes.txt) built a string the containment check
 * answered as inside the tree, so an out-of-tree read ran with no approval
 * card and a Read deny rule naming the real path could not bite (FN-015
 * rank 52). A bare drive with no separator (C:notes.txt) is drive-relative,
 * not absolute, and keeps its later NTFS-stream ask. Exported for the unit
 * pin: the ladder past this point rides win32 path semantics.
 */
export function resolveOperandPath(path: string, cwd: string): string {
  if (path.startsWith('/') || DRIVE_QUALIFIED.test(path)) return path
  return `${cwd}/${path}`
}

function canonicalise(path: string): string {
  try {
    return safeResolvePath(getFsImplementation(), path).resolvedPath
  } catch {
    return path
  }
}

function notAllowed(resolvedPath: string, reason: PermissionDecisionReason): ResolveResult {
  return { allowed: false, resolvedPath, reason }
}
function other(reason: string): PermissionDecisionReason {
  return { type: 'other', reason }
}

// ── dangerous-removal hard deny ──────────────────────────────────────

/** Check the user-typed shape for a dangerous removal path. */
export function isDangerousRemovalRawPath(path: string): boolean {
  let p = path
  if (/^['"]/.test(p)) p = p.slice(1)
  if (/['"]$/.test(p)) p = p.slice(0, -1)
  p = expandTilde(p).replace(/\\/g, '/')
  return isDangerousRemovalPath(p)
}

/** A deny result for a dangerous removal. A user cannot approve this. */
export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Remove-Item of "${path}" is refused: this location is under blanket protection against deletion and cannot be approved.`,
    decisionReason: other(`Dangerous removal of a protected path: ${path}`),
  }
}

// ── the entry point ──────────────────────────────────────────────────

/** The two-pass path-constraint entry point. */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  context: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  if (!parsed.valid) return { behavior: 'passthrough', message: 'Paths cannot be validated on an unparseable command.' }
  const cwd = getCwd()
  let firstAsk: PermissionResult | null = null
  const seedAsk = (result: PermissionResult): void => {
    if (result.behavior === 'ask' && firstAsk === null) firstAsk = result
  }

  for (const statement of getPipelineSegments(parsed)) {
    if (compoundCommandHasCd) {
      seedAsk({ behavior: 'ask', message: 'This compound changes the working directory (Set-Location / Push-Location / Pop-Location / New-PSDrive), so relative paths cannot be validated against the original working directory.', decisionReason: other('A compound directory change makes relative paths unresolvable.') })
    }
    for (const command of statement.commands) {
      const verdict = checkOneCommand(command, cwd, context)
      if (verdict?.behavior === 'deny') return verdict
      if (verdict) seedAsk(verdict)
    }
    for (const nested of statement.nestedCommands) {
      const verdict = checkOneCommandNested(nested, cwd, context)
      if (verdict?.behavior === 'deny') return verdict
      if (verdict) seedAsk(verdict)
    }
    for (const redirect of [...statement.redirections]) {
      if (redirect.isMerging || !redirect.target || redirect.target.toLowerCase() === '$null') continue
      const decision = resolveAndDecide(redirect.target, cwd, context, 'write')
      if (!decision.allowed) {
        if (decision.reason?.type === 'rule') return { behavior: 'deny', message: redirMessage(decision, context), decisionReason: decision.reason }
        seedAsk({ behavior: 'ask', message: redirMessage(decision, context), blockedPath: decision.resolvedPath, decisionReason: decision.reason, suggestions: decision.resolvedPath ? [addDir(decision.resolvedPath)] : [] })
      }
    }
  }
  return firstAsk ?? { behavior: 'passthrough', message: 'Path validation found no concern.' }
}

function checkOneCommand(command: ParsedCommandElement, cwd: string, context: ToolPermissionContext): PermissionResult | null {
  const extracted = extractPaths(command)
  const canonical = resolveToCanonical(command.name)
  if (extracted.unvalidatable) {
    // fall through, but seed an ask below via the caller; here return null and let deny checks run
  }
  if (extracted.operation !== 'read' && !extracted.optionalWrite && extracted.paths.length === 0 && extracted.hasConfig) {
    return { behavior: 'ask', message: `${canonical} has no determinable write target.`, decisionReason: other('A write operation with no target.') }
  }
  for (const rawPath of extracted.paths) {
    if (canonical === REMOVAL_CANONICAL && isDangerousRemovalRawPath(rawPath)) return dangerousRemovalDeny(rawPath)
    const decision = resolveAndDecide(rawPath, cwd, context, extracted.operation)
    if (canonical === REMOVAL_CANONICAL && isDangerousRemovalRawPath(decision.resolvedPath)) return dangerousRemovalDeny(decision.resolvedPath)
    if (!decision.allowed) {
      if (decision.reason?.type === 'rule') return { behavior: 'deny', message: pathMessage(canonical, decision, context), decisionReason: decision.reason }
      return askForPath(canonical, decision, extracted.operation, context)
    }
  }
  if (extracted.unvalidatable) {
    return { behavior: 'ask', message: `${canonical} has an argument (array literal, sub-expression, or unrecognised parameter) beyond static checking.`, decisionReason: other('An unvalidatable path argument.') }
  }
  return null
}

function checkOneCommandNested(command: ParsedCommandElement, cwd: string, context: ToolPermissionContext): PermissionResult | null {
  return checkOneCommand(command, cwd, context)
}

function askForPath(canonical: string, decision: ResolveResult, operation: OperationType, context: ToolPermissionContext): PermissionResult {
  const suggestions: PermissionUpdate[] = []
  if (decision.resolvedPath) {
    const dir = getDirectoryForPath(decision.resolvedPath)
    if (operation === 'read') {
      const rule = createReadRuleSuggestion(dir)
      if (rule) suggestions.push(rule)
    } else {
      suggestions.push(addDir(decision.resolvedPath))
      suggestions.push({ type: 'setMode', destination: 'session', mode: 'implement' })
    }
  }
  return { behavior: 'ask', message: pathMessage(canonical, decision, context), blockedPath: decision.resolvedPath, decisionReason: decision.reason, suggestions }
}

function addDir(resolvedPath: string): PermissionUpdate {
  return { type: 'addDirectories', destination: 'session', directories: [getDirectoryForPath(resolvedPath)] }
}

function pathMessage(canonical: string, decision: ResolveResult, context: ToolPermissionContext): string {
  if (decision.reason && (decision.reason.type === 'other' || decision.reason.type === 'safetyCheck')) return decision.reason.reason
  return `${canonical} targets ${decision.resolvedPath}, outside the allowed working directories (${formatDirs(context)}).`
}
function redirMessage(decision: ResolveResult, context: ToolPermissionContext): string {
  if (decision.reason && (decision.reason.type === 'other' || decision.reason.type === 'safetyCheck')) return decision.reason.reason
  return `The redirection target ${decision.resolvedPath} is outside the allowed working directories (${formatDirs(context)}).`
}
function formatDirs(context: ToolPermissionContext): string {
  const dirs = [...allWorkingDirectories(context)].map(d => `'${d}'`)
  return dirs.length <= 5 ? dirs.join(', ') : `${dirs.slice(0, 5).join(', ')} and ${dirs.length - 5} more`
}
