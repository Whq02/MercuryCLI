/**
 * PowerShell read-only classification: the authoritative allowlist evaluation
 * plus alias canonicalisation, the sync pre-filter, and the argument-leak gate.
 * Fail-closed: an invalid parse, a missing element-type list, or a construct the
 * allowlist cannot account for is not read-only.
 */
import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'

type ParsedStatement = ParsedPowerShellCommand['statements'][number]
import {
  validateFlags,
  GIT_READ_ONLY_COMMANDS,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type ExternalCommandConfig,
} from '../../utils/shell/readOnlyCommandValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'
import { getPlatform } from '../../utils/platform.js'

/** PowerShell dash characters (ASCII + Unicode alternatives). */
const PS_DASH_CHARS = '-–—―'
const PS_DASH_RE = /[-–—―]/

/** The allowlist value shape (not exported; only observable through CMDLET_ALLOWLIST). */
type CommandConfig = {
  safeFlags?: string[]
  allowAllFlags?: boolean
  regex?: RegExp
  additionalDanger?: (command: string, element?: ParsedCommandElement) => boolean
}

/** Split a space-separated flag string into a lowercase safe-flag list. */
function flags(spec: string): string[] {
  return spec.trim().split(/\s+/).map(f => f.toLowerCase())
}

const allowAll: CommandConfig = { allowAllFlags: true }

// ── alias canonicalisation and namespace-changing cmdlets ──────────────

const PATHEXT = /\.(?:exe|cmd|bat|com)$/i

/** Lowercase; strip a PATHEXT suffix (only when no path separator); resolve through the alias table. */
export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase()
  if (!/[\\/]/.test(lower)) lower = lower.replace(PATHEXT, '')
  const aliased = (COMMON_ALIASES as Record<string, string | undefined>)[lower]
  // The alias table's values are PascalCase (`iex → Invoke-Expression`) while
  // every consumer compares against lowercase literals — the security battery
  // sets, the cwd-change test, the read-only allowlist keys — so the canonical
  // name is lowercase in EVERY case, alias or not.
  return aliased !== undefined ? aliased.toLowerCase() : lower
}

/** True when the canonical name alters the path-resolution namespace. */
export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name)
  if (canonical === 'set-location' || canonical === 'push-location' || canonical === 'pop-location' || canonical === 'new-psdrive') {
    return true
  }
  if (getPlatform() === 'windows' && (canonical === 'ndr' || canonical === 'mount')) return true
  return false
}

// ── the read-only cmdlet allowlist (contract data) ─────────────────────

const argLeakCallback = (command: string, element?: ParsedCommandElement): boolean => argLeaksValue(command, element)

/** Callback rejecting any positional argument (bare token not starting with a dash/slash). */
function rejectsPositional(_command: string, element?: ParsedCommandElement): boolean {
  if (!element) return true
  const types = element.elementTypes
  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i] as string
    if (!PS_DASH_RE.test(arg[0] ?? '') && arg[0] !== '/') {
      if (types && types[i] === 'Parameter') continue
      return true
    }
  }
  return false
}

/** route: first non-flag positional must be exactly the print verb; absent element is dangerous. */
function routeRequiresPrint(_command: string, element?: ParsedCommandElement): boolean {
  if (!element) return true
  const firstPositional = element.args.find(a => !PS_DASH_RE.test(a[0] ?? '') && a[0] !== '/')
  return (firstPositional ?? '').toLowerCase() !== 'print'
}

/** The read-only cmdlet allowlist. Prototype-free (null prototype). */
export const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(Object.create(null), {
  'get-childitem': { safeFlags: flags('-Path -LiteralPath -Filter -Include -Exclude -Recurse -Depth -Name -Force -Attributes -Directory -File -Hidden -ReadOnly -System') },
  'get-content': { safeFlags: flags('-Path -LiteralPath -TotalCount -Head -Tail -Raw -Encoding -Delimiter -ReadCount') },
  'get-item': { safeFlags: flags('-Path -LiteralPath -Force -Stream') },
  'get-itemproperty': { safeFlags: flags('-Path -LiteralPath -Name') },
  'test-path': { safeFlags: flags('-Path -LiteralPath -PathType -Filter -Include -Exclude -IsValid -NewerThan -OlderThan') },
  'resolve-path': { safeFlags: flags('-Path -LiteralPath -Relative') },
  'get-filehash': { safeFlags: flags('-Path -LiteralPath -Algorithm -InputStream') },
  'get-acl': { safeFlags: flags('-Path -LiteralPath -Audit -Filter -Include -Exclude') },
  'set-location': { safeFlags: flags('-Path -LiteralPath -PassThru -StackName') },
  'push-location': { safeFlags: flags('-Path -LiteralPath -PassThru -StackName') },
  'pop-location': { safeFlags: flags('-PassThru -StackName') },
  'select-string': { safeFlags: flags('-Path -LiteralPath -Pattern -InputObject -SimpleMatch -CaseSensitive -Quiet -List -NotMatch -AllMatches -Encoding -Context -Raw -NoEmphasis') },
  'convertto-json': { safeFlags: flags('-InputObject -Depth -Compress -EnumsAsStrings -AsArray') },
  'convertfrom-json': { safeFlags: flags('-InputObject -Depth -AsHashtable -NoEnumerate') },
  'convertto-csv': { safeFlags: flags('-InputObject -Delimiter -NoTypeInformation -NoHeader -UseQuotes') },
  'convertfrom-csv': { safeFlags: flags('-InputObject -Delimiter -Header -UseCulture') },
  'convertto-xml': { safeFlags: flags('-InputObject -Depth -As -NoTypeInformation') },
  'convertto-html': { safeFlags: flags('-InputObject -Property -Head -Title -Body -Pre -Post -As -Fragment') },
  'format-hex': { safeFlags: flags('-Path -LiteralPath -InputObject -Encoding -Count -Offset') },
  'get-member': { safeFlags: flags('-InputObject -MemberType -Name -Static -View -Force') },
  'get-unique': { safeFlags: flags('-InputObject -AsString -CaseInsensitive -OnType') },
  'compare-object': { safeFlags: flags('-ReferenceObject -DifferenceObject -Property -SyncWindow -CaseSensitive -Culture -ExcludeDifferent -IncludeEqual -PassThru') },
  'join-string': { safeFlags: flags('-InputObject -Property -Separator -OutputPrefix -OutputSuffix -SingleQuote -DoubleQuote -FormatString') },
  'get-random': { safeFlags: flags('-InputObject -Minimum -Maximum -Count -SetSeed -Shuffle') },
  'convert-path': { safeFlags: flags('-Path -LiteralPath') },
  'join-path': { safeFlags: flags('-Path -ChildPath -AdditionalChildPath') },
  'split-path': { safeFlags: flags('-Path -LiteralPath -Qualifier -NoQualifier -Parent -Leaf -LeafBase -Extension -IsAbsolute') },
  'get-hotfix': { safeFlags: flags('-Id -Description') },
  'get-itempropertyvalue': { safeFlags: flags('-Path -LiteralPath -Name') },
  'get-psprovider': { safeFlags: flags('-PSProvider') },
  'get-process': { safeFlags: flags('-Name -Id -Module -FileVersionInfo -IncludeUserName') },
  'get-service': { safeFlags: flags('-Name -DisplayName -DependentServices -RequiredServices -Include -Exclude') },
  'get-computerinfo': allowAll, 'get-host': allowAll, 'get-culture': allowAll, 'get-uiculture': allowAll, 'get-uptime': allowAll, 'ver': allowAll,
  'get-date': { safeFlags: flags('-Date -Format -UFormat -DisplayHint -AsUTC') },
  'get-location': { safeFlags: flags('-PSProvider -PSDrive -Stack -StackName') },
  'get-psdrive': { safeFlags: flags('-Name -PSProvider -Scope') },
  'get-module': { safeFlags: flags('-Name -ListAvailable -All -FullyQualifiedName -PSEdition') },
  'get-alias': { safeFlags: flags('-Name -Definition -Scope -Exclude') },
  'get-history': { safeFlags: flags('-Id -Count') },
  'get-timezone': { safeFlags: flags('-Name -Id -ListAvailable') },
  'write-output': { safeFlags: flags('-InputObject -NoEnumerate'), additionalDanger: argLeakCallback },
  'write-host': { safeFlags: flags('-Object -NoNewline -Separator -ForegroundColor -BackgroundColor'), additionalDanger: argLeakCallback },
  'start-sleep': { safeFlags: flags('-Seconds -Milliseconds -Duration'), additionalDanger: argLeakCallback },
  'get-netadapter': { safeFlags: flags('-Name -InterfaceDescription -InterfaceIndex -Physical') },
  'get-netipaddress': { safeFlags: flags('-InterfaceIndex -InterfaceAlias -AddressFamily -Type') },
  'get-netipconfiguration': { safeFlags: flags('-InterfaceIndex -InterfaceAlias -Detailed -All') },
  'get-netroute': { safeFlags: flags('-InterfaceIndex -InterfaceAlias -AddressFamily -DestinationPrefix') },
  'get-dnsclientcache': { safeFlags: flags('-Entry -Name -Type -Status -Section -Data') },
  'get-dnsclient': { safeFlags: flags('-InterfaceIndex -InterfaceAlias') },
  'get-eventlog': { safeFlags: flags('-LogName -Newest -After -Before -EntryType -Index -InstanceId -Message -Source -UserName -AsBaseObject -List') },
  'get-winevent': { safeFlags: flags('-LogName -ListLog -ListProvider -ProviderName -Path -MaxEvents -FilterXPath -Force -Oldest') },
  'get-cimclass': { safeFlags: flags('-ClassName -Namespace -MethodName -PropertyName -QualifierName') },
  ipconfig: { safeFlags: flags('/all /displaydns /allcompartments'), additionalDanger: rejectsPositional },
  netstat: { safeFlags: flags('-a -b -e -f -n -o -p -q -r -s -t -x -y') },
  systeminfo: { safeFlags: flags('/FO /NH') },
  tasklist: { safeFlags: flags('/M /SVC /V /FI /FO /NH') },
  'where.exe': allowAll,
  hostname: { safeFlags: flags('-a -d -f -i -I -s -y -A'), additionalDanger: rejectsPositional },
  whoami: { safeFlags: flags('/user /groups /claims /priv /logonid /all /fo /nh') },
  arp: { safeFlags: flags('-a -g -v -N') },
  route: { safeFlags: flags('print PRINT -4 -6'), additionalDanger: routeRequiresPrint },
  getmac: { safeFlags: flags('/FO /NH /V') },
  tree: { safeFlags: flags('/F /A /Q /L') },
  findstr: { safeFlags: flags('/B /E /L /R /S /I /X /V /N /M /O /P /C /G /D /A') },
  file: { safeFlags: flags('-b --brief -i --mime -L --dereference --mime-type --mime-encoding -z --uncompress -p --preserve-date -k --keep-going -r --raw -v --version -0 --print0 -s --special-files -l -F --separator -e -P -N --no-pad -E --extension') },
  // External dispatch entries carry empty configs.
  git: {}, gh: {}, docker: {}, dotnet: {},
  // Pipeline-tail formatters allow all flags + the argument-leak callback.
  ...Object.fromEntries(
    ['format-table', 'format-list', 'format-wide', 'format-custom', 'measure-object', 'select-object', 'sort-object', 'group-object', 'where-object', 'out-string', 'out-host'].map(name => [
      name, { allowAllFlags: true, additionalDanger: argLeakCallback } as CommandConfig,
    ]),
  ),
})

/** The safe-output set (contract data): only out-null. */
export function isSafeOutputCommand(name: string): boolean {
  return resolveToCanonical(name) === 'out-null'
}

/** The migrated pipeline-tail set (contract data). */
const PIPELINE_TAIL = new Set(['format-table', 'format-list', 'format-wide', 'format-custom', 'measure-object', 'select-object', 'sort-object', 'group-object', 'where-object', 'out-string', 'out-host'])

/** The safe-external-executable bypass set (contract data). */
const SAFE_EXTERNAL = new Set(['where.exe'])

/** Metacharacters that make an argument unverifiable. */
const LEAK_METACHARS = /[$(@{[]/

// ── the argument-leak gate ────────────────────────────────────────────────────

/** Whether an invocation leaks or coerces an unvalidatable value. FAIL-OPEN on a missing type list. */
export function argLeaksValue(_command: string, element?: ParsedCommandElement): boolean {
  if (!element) return false
  const types = element.elementTypes
  if (!types) return false // fail-open (contrast the allowlist's fail-closed)
  for (let i = 0; i < element.args.length; i++) {
    if (argumentLeaks(element, types, i)) return true
  }
  return false
}

/** Whether argument i of an element leaks (the shared metachar + colon-child test). */
function argumentLeaks(element: ParsedCommandElement, types: readonly (string | undefined)[], i: number): boolean {
  const arg = element.args[i] as string
  const type = types[i]
  if (type !== 'StringConstant' && type !== 'Parameter') {
    if (LEAK_METACHARS.test(arg)) return true
  }
  if (type === 'Parameter') {
    const children = element.children?.[i]
    if (children) {
      if (children.some(child => child.type !== 'StringConstant')) return true
    } else {
      const colon = arg.indexOf(':', 1)
      if (colon !== -1 && LEAK_METACHARS.test(arg.slice(colon + 1))) return true
    }
  }
  return false
}

// ── the per-command allowlist evaluation ──────────────────────────────────────

/** Per-command allowlist evaluation. */
export function isAllowlistedCommand(element: ParsedCommandElement, originalCommand: string): boolean {
  // 1. Name-type gate.
  if (element.nameType === 'application') {
    const rawFirst = (element.text.trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (!SAFE_EXTERNAL.has(rawFirst)) return false
  }
  // 2. Configuration lookup (direct then alias-canonical).
  const direct = CMDLET_ALLOWLIST[element.name.toLowerCase()]
  const config = direct ?? CMDLET_ALLOWLIST[resolveToCanonical(element.name)]
  if (!config) return false
  // 3. Regex constraint.
  if (config.regex && !config.regex.test(originalCommand)) return false
  // 4. Additional-danger callback.
  if (config.additionalDanger && config.additionalDanger(originalCommand, element)) return false
  // 5. Argument element-type whitelist — FAIL-CLOSED on a missing list.
  const types = element.elementTypes
  if (!types) return false
  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i] as string
    const type = types[i]
    if (type !== 'StringConstant' && type !== 'Parameter') {
      if (LEAK_METACHARS.test(arg)) return false
    }
    if (type === 'Parameter') {
      const children = element.children?.[i]
      if (children) {
        if (children.some(child => child.type !== 'StringConstant')) return false
      } else {
        const colon = arg.indexOf(':', 1)
        if (colon !== -1 && LEAK_METACHARS.test(arg.slice(colon + 1))) return false
      }
    }
  }
  // 6. External command dispatch.
  const canonical = resolveToCanonical(element.name)
  if (canonical === 'git' || canonical === 'gh' || canonical === 'docker' || canonical === 'dotnet') {
    return isExternalReadOnly(canonical, element.args)
  }
  // 7. Flag validation.
  return validatePsFlags(canonical, element, config)
}

/** Flag validation for a cmdlet/executable against its config. */
function validatePsFlags(canonical: string, element: ParsedCommandElement, config: CommandConfig): boolean {
  if (config.allowAllFlags) return true
  const isCmdlet = canonical.includes('-')
  const safeFlags = config.safeFlags
  const types = element.elementTypes
  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i] as string
    const isParam = isCmdlet
      ? (types ? types[i] === 'Parameter' : isPowerShellParameter(arg))
      : arg.startsWith('-') || (getPlatform() === 'windows' && arg.startsWith('/'))
    if (!isParam) continue
    if (!safeFlags || safeFlags.length === 0) return false // reject all flags by default
    let name = isCmdlet ? '-' + arg.replace(PS_DASH_RE, '').replace(/^-?/, '') : arg
    name = normaliseDash(arg)
    const colon = name.indexOf(':', 1)
    if (colon !== -1) name = name.slice(0, colon)
    name = name.toLowerCase()
    if (isCmdlet && COMMON_PARAMETERS.has(name)) continue
    if (!safeFlags.includes(name)) return false
  }
  return true
}

function normaliseDash(arg: string): string {
  if (PS_DASH_RE.test(arg[0] ?? '')) return '-' + arg.slice(1)
  return arg
}

// ── external command read-only validation ─────────────────────────────────────

function isExternalReadOnly(canonical: string, args: string[]): boolean {
  if (canonical === 'gh') return false // always unsafe (never auto-allowed)
  if (canonical === 'git') return gitReadOnly(args)
  if (canonical === 'docker') return dockerReadOnly(args)
  if (canonical === 'dotnet') {
    if (args.length === 0) return false
    const ok = new Set(['--version', '--info', '--list-runtimes', '--list-sdks'])
    return args.every(a => ok.has(a.toLowerCase()))
  }
  return false
}

const GIT_REJECT_GLOBAL = new Set(['-c', '-C', '--exec-path', '--config-env', '--git-dir', '--work-tree', '--attr-source'])
const GIT_VALUE_GLOBAL = new Set(['-c', '-C', '--exec-path', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file'])

function gitReadOnly(args: string[]): boolean {
  if (args.length === 0) return true
  if (args.some(a => a.includes('$'))) return false
  let i = 0
  while (i < args.length) {
    const arg = args[i] as string
    if (!arg.startsWith('-')) break
    const eq = arg.indexOf('=')
    const flagPart = eq === -1 ? arg : arg.slice(0, eq)
    // Attached-form short flags.
    if (arg.length > 2 && arg.startsWith('-c') && arg[2] !== '-') return false
    if (arg.length > 2 && arg.startsWith('-C')) return false
    if (GIT_REJECT_GLOBAL.has(flagPart)) return false
    if (eq === -1 && GIT_VALUE_GLOBAL.has(arg)) i += 2
    else i += 1
  }
  if (i >= args.length) return true // consumed every argument → safe
  const tail = args.slice(i)
  const first = (tail[0] as string).toLowerCase()
  const twoWord = tail.length >= 2 ? `git ${first} ${(tail[1] as string).toLowerCase()}` : null
  const config = (twoWord && GIT_READ_ONLY_COMMANDS[twoWord]) || GIT_READ_ONLY_COMMANDS[`git ${first}`]
  if (!config) return false
  if (first === 'ls-remote') {
    for (const arg of tail.slice(1)) {
      if (arg.startsWith('-')) continue
      if (arg.includes('://') || arg.includes('@') || arg.includes(':') || arg.includes('$')) return false
    }
  }
  if (config.additionalCommandIsDangerousCallback && config.additionalCommandIsDangerousCallback('', tail)) return false
  return validateFlags(tail, 0, config, { commandName: 'git' })
}

function dockerReadOnly(args: string[]): boolean {
  if (args.length === 0) return true
  if (args.some(a => a.includes('$'))) return false
  const first = (args[0] as string).toLowerCase()
  if (EXTERNAL_READONLY_COMMANDS.includes(`docker ${first}`)) return true
  const config = DOCKER_READ_ONLY_COMMANDS[`docker ${first}`]
  if (!config) return false
  if (config.additionalCommandIsDangerousCallback && config.additionalCommandIsDangerousCallback('', args.slice(1))) return false
  return validateFlags(args, 1, config, { commandName: 'docker' })
}

// ── isAllowlistedPipelineTail / isProvablySafeStatement / isReadOnlyCommand ──

/** True when the canonical name is a pipeline tail AND the element passes the full allowlist check. */
export function isAllowlistedPipelineTail(element: ParsedCommandElement, originalCommand: string): boolean {
  if (!PIPELINE_TAIL.has(resolveToCanonical(element.name))) return false
  return isAllowlistedCommand(element, originalCommand)
}

/** The fail-closed statement gate: a pipeline statement with ≥1 command, every element a command. */
export function isProvablySafeStatement(statement: ParsedStatement): boolean {
  if (statement.statementType !== 'pipeline') return false
  if (statement.commands.length === 0) return false
  // A non-command pipeline element surfaces as a nested command or a non-command marker;
  // in this parse a "provably safe" statement has only command elements.
  return statement.nestedCommands.length === 0
}

/** The authoritative read-only check. */
export function isReadOnlyCommand(command: string, parsed?: ParsedPowerShellCommand): boolean {
  if (command.trim() === '') return false
  if (!parsed || !parsed.valid) return false
  const flags = deriveSecurityFlags(parsed)
  if (
    flags.hasScriptBlocks || flags.hasSubExpressions || flags.hasExpandableStrings ||
    flags.hasSplatting || flags.hasMemberInvocations || flags.hasAssignments || flags.hasStopParsing
  ) return false

  const segments = getPipelineSegments(parsed)
  if (segments.length === 0) return false

  const totalCommands = segments.reduce((sum, s) => sum + s.commands.length, 0)
  if (totalCommands > 1 && segments.some(s => s.commands.some(c => isCwdChangingCmdlet(c.name)))) return false

  for (const statement of segments) {
    if (statement.commands.length === 0) return false
    for (const redirect of statement.redirections) {
      if (!redirect.isMerging && !isNullRedirectionTarget(redirect.target)) return false
    }
    if (statement.nestedCommands.length > 0) return false
    const [first, ...rest] = statement.commands
    if (!first || !isAllowlistedCommand(first, command)) return false
    for (const command_ of rest) {
      if (command_.nameType === 'application') return false
      if (isSafeOutputCommand(command_.name) && command_.args.length === 0) continue
      if (!isAllowlistedCommand(command_, command)) return false
    }
  }
  return true
}

// ── hasSyncSecurityConcerns ──────────────────────────────────────────────

/** A fast, deliberately over-broad regex pre-filter for the synchronous interface. */
export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (/\$\(/.test(trimmed)) return true // sub-expression opener
  if (/(?:^|[^\w.])@\w/.test(trimmed)) return true // splatting
  if (/\.\w+\s*\(/.test(trimmed)) return true // member invocation
  if (/[$]?\w+\s*[-+*/]?=/.test(trimmed) && /^\s*\$?\w+\s*[-+*/]?=/.test(trimmed)) return true // assignment
  if (trimmed.includes('--%')) return true // stop-parsing token
  if (/\\\\|(?<!:)\/\//.test(trimmed)) return true // UNC path
  if (trimmed.includes('::')) return true // static-method separator
  return false
}

void PS_DASH_CHARS
