import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../utils/powershell/parser.js'

type ParsedStatement = ParsedPowerShellCommand['statements'][number]
import {
  validateFlags,
  GIT_READ_ONLY_COMMANDS,
  DOCKER_READ_ONLY_COMMANDS,
} from '../../utils/shell/readOnlyCommandValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'
import { getPlatform } from '../../utils/platform.js'

const PS_DASH_RE = /[-–—―]/

type CommandConfig = {
  safeFlags?: string[]
  allowAllFlags?: boolean
  regex?: RegExp
  additionalDanger?: (command: string, element?: ParsedCommandElement) => boolean
}

function flags(spec: string): string[] {
  return spec.trim().split(/\s+/).map(f => f.toLowerCase())
}

const allowAll: CommandConfig = { allowAllFlags: true }


const PATHEXT = /\.(?:exe|cmd|bat|com)$/i

const CWD_CHANGING_CMDLETS = new Set(['set-location', 'push-location', 'pop-location', 'new-psdrive'])
const WINDOWS_CWD_ALIASES = new Set(['ndr', 'mount'])

export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase()
  if (!lower.includes('/') && !lower.includes('\\')) {
    lower = lower.replace(PATHEXT, '')
  }
  const alias = Object.prototype.hasOwnProperty.call(COMMON_ALIASES, lower)
    ? COMMON_ALIASES[lower]
    : undefined
  return alias ? alias.toLowerCase() : lower
}

export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name)
  if (CWD_CHANGING_CMDLETS.has(canonical)) return true
  if (getPlatform() === 'windows' && WINDOWS_CWD_ALIASES.has(canonical)) return true
  return false
}


const argLeakCallback = (command: string, element?: ParsedCommandElement): boolean => argLeaksValue(command, element)

function rejectsPositional(_command: string, element?: ParsedCommandElement): boolean {
  if (!element) return true
  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i] as string
    if (!PS_DASH_RE.test(arg[0] ?? '') && arg[0] !== '/') {
      if (argumentTypeAt(element, i) === 'Parameter') continue
      return true
    }
  }
  return false
}

function routeRequiresPrint(_command: string, element?: ParsedCommandElement): boolean {
  if (!element) return true
  const firstPositional = element.args.find(a => !PS_DASH_RE.test(a[0] ?? '') && a[0] !== '/')
  return (firstPositional ?? '').toLowerCase() !== 'print'
}

const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(Object.create(null), {
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
  git: {}, gh: {}, docker: {}, dotnet: {},
  ...Object.fromEntries(
    ['format-table', 'format-list', 'format-wide', 'format-custom', 'measure-object', 'select-object', 'sort-object', 'group-object', 'where-object', 'out-string', 'out-host'].map(name => [
      name, { allowAllFlags: true, additionalDanger: argLeakCallback } as CommandConfig,
    ]),
  ),
})

const PIPELINE_TAIL_CMDLETS = new Set([
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'measure-object',
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'out-string',
  'out-host',
])

export function isSafeOutputCommand(name: string): boolean {
  return resolveToCanonical(name) === 'out-null'
}

const SAFE_EXTERNAL = new Set(['where.exe'])

const LEAK_METACHARS = /[$(@{[]/


export function argLeaksValue(_command: string, element?: ParsedCommandElement): boolean {
  if (!element?.elementTypes) return false
  for (let i = 0; i < element.args.length; i++) {
    if (argumentLeaks(element, i)) return true
  }
  return false
}

function argumentLeaks(element: ParsedCommandElement, i: number): boolean {
  const kind = argumentTypeAt(element, i)
  if (kind === 'StringConstant') return false
  const arg = element.args[i] ?? ''
  if (kind === 'Parameter') {
    const children = element.children?.[i]
    if (children && children.some(child => child.type !== 'StringConstant')) return true
    const colon = arg.indexOf(':', 1)
    return colon !== -1 && LEAK_METACHARS.test(arg.slice(colon + 1))
  }
  return LEAK_METACHARS.test(arg)
}


export function isAllowlistedCommand(element: ParsedCommandElement, originalCommand: string): boolean {
  const rawLower = element.name.toLowerCase()
  if (element.nameType === 'application' && !SAFE_EXTERNAL.has(rawLower)) {
    return false
  }
  const canonical = resolveToCanonical(element.name)
  const config = CMDLET_ALLOWLIST[rawLower] ?? CMDLET_ALLOWLIST[canonical]
  if (!config) return false
  if (config.regex && !config.regex.test(originalCommand)) return false
  if (config.additionalDanger && config.additionalDanger(originalCommand, element)) return false
  if (!element.elementTypes) return false

  for (let i = 0; i < element.args.length; i++) {
    if (argumentLeaks(element, i)) return false
  }

  if (canonical === 'git' || canonical === 'gh' || canonical === 'docker' || canonical === 'dotnet') {
    return isExternalReadOnly(canonical, element.args)
  }

  if (config.allowAllFlags) return true

  const isCmdlet = canonical.includes('-')
  const allowSlashFlags = !isCmdlet && getPlatform() === 'windows'
  const safeFlags = config.safeFlags ?? []

  for (let i = 0; i < element.args.length; i++) {
    const arg = element.args[i]!
    const kind = argumentTypeAt(element, i)
    const isParam = isPowerShellParameter(arg, kind) || (allowSlashFlags && arg.startsWith('/'))
    if (!isParam) continue
    let flag = normaliseDash(arg).toLowerCase()
    const colon = flag.indexOf(':', 1)
    if (colon !== -1) flag = flag.slice(0, colon)
    if (isCmdlet && COMMON_PARAMETERS.has(flag)) continue
    if (!safeFlags.includes(flag)) return false
  }

  return true
}

function normaliseDash(arg: string): string {
  if (PS_DASH_RE.test(arg[0] ?? '')) return '-' + arg.slice(1)
  return arg
}


function isExternalReadOnly(canonical: string, args: string[]): boolean {
  if (canonical === 'gh') return false
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
  if (args.some(arg => arg.includes('$'))) return false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (!arg.startsWith('-')) break
    const eq = arg.indexOf('=')
    const flagName = eq !== -1 ? arg.slice(0, eq) : arg
    if (GIT_REJECT_GLOBAL.has(flagName)) return false
    if ((arg.startsWith('-c') || arg.startsWith('-C')) && arg.length > 2) return false
    if (GIT_VALUE_GLOBAL.has(flagName) && eq === -1) {
      i += 2
    } else {
      i += 1
    }
  }

  if (i >= args.length) return true

  const sub1 = args[i]!.toLowerCase()
  const sub2 = args[i + 1]?.toLowerCase()
  let key: string | undefined
  let flagStart = i + 1
  if (sub2 !== undefined && Object.prototype.hasOwnProperty.call(GIT_READ_ONLY_COMMANDS, `git ${sub1} ${sub2}`)) {
    key = `git ${sub1} ${sub2}`
    flagStart = i + 2
  } else if (Object.prototype.hasOwnProperty.call(GIT_READ_ONLY_COMMANDS, `git ${sub1}`)) {
    key = `git ${sub1}`
    flagStart = i + 1
  }
  if (!key) return false

  const config = GIT_READ_ONLY_COMMANDS[key]!
  if (!validateFlags(args, flagStart, config, { commandName: 'git' })) return false
  if (config.additionalCommandIsDangerousCallback) {
    if (config.additionalCommandIsDangerousCallback(`git ${args.join(' ')}`, args.slice(flagStart))) {
      return false
    }
  }
  return true
}

function dockerReadOnly(args: string[]): boolean {
  if (args.length === 0) return false
  if (args.some(arg => arg.includes('$'))) return false
  const sub = args[0]!.toLowerCase()
  const key = `docker ${sub}`
  if (!Object.prototype.hasOwnProperty.call(DOCKER_READ_ONLY_COMMANDS, key)) return false
  const config = DOCKER_READ_ONLY_COMMANDS[key]!
  if (!validateFlags(args, 1, config, { commandName: 'docker' })) return false
  if (config.additionalCommandIsDangerousCallback) {
    if (config.additionalCommandIsDangerousCallback(`docker ${args.join(' ')}`, args.slice(1))) {
      return false
    }
  }
  return true
}


export function isAllowlistedPipelineTail(element: ParsedCommandElement, originalCommand: string): boolean {
  return PIPELINE_TAIL_CMDLETS.has(resolveToCanonical(element.name)) && isAllowlistedCommand(element, originalCommand)
}

export function isProvablySafeStatement(statement: ParsedStatement): boolean {
  return (
    (statement.statementType === 'PipelineAst' || statement.statementType === 'pipeline') &&
    statement.commands.length > 0 &&
    statement.nestedCommands.length === 0
  )
}

export function isReadOnlyCommand(command: string, parsed?: ParsedPowerShellCommand): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (!parsed || !parsed.valid) return false

  const flags = deriveSecurityFlags(parsed)
  if (
    flags.hasScriptBlocks ||
    flags.hasSubExpressions ||
    flags.hasExpandableStrings ||
    flags.hasMemberInvocations ||
    flags.hasAssignments ||
    flags.hasSplatting ||
    flags.hasStopParsing
  ) {
    return false
  }

  const segments = getPipelineSegments(parsed)
  if (segments.length === 0) return false

  const isCompound = segments.length > 1 || segments.some(stmt => stmt.commands.length > 1)

  for (const stmt of segments) {
    if (!isProvablySafeStatement(stmt)) return false

    for (const redir of stmt.redirections) {
      if (!redir.isMerging && !isNullRedirectionTarget(redir.target)) return false
    }

    for (let i = 0; i < stmt.commands.length; i++) {
      const cmd = stmt.commands[i]!
      if (isCompound && isCwdChangingCmdlet(cmd.name)) return false
      for (const redir of cmd.redirections ?? []) {
        if (!redir.isMerging && !isNullRedirectionTarget(redir.target)) return false
      }
      if (i === 0) {
        if (!isAllowlistedCommand(cmd, cmd.text || trimmed)) return false
      } else {
        if (cmd.nameType === 'application') return false
        if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) continue
        if (!isAllowlistedCommand(cmd, cmd.text || trimmed)) return false
      }
    }
  }

  return true
}


const UNSAFE_UNQUOTED_SYNTAX = /[({#]|(?<![>&])&(?!&)/

export function stripPowerShellQuotes(command: string): string {
  return command.replace(/`[\s\S]|'(?:''|[^'])*'|"(?:`[\s\S]|""|[^"`])*"/g, match => (match[0] === '`' ? match : '_'))
}

export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (/\$\(/.test(trimmed)) return true
  if (/(?:^|[^\w.])@\w/.test(trimmed)) return true
  if (/\.\w+\s*\(/.test(trimmed)) return true
  if (/[$]?\w+\s*[-+*/]?=/.test(trimmed) && /^\s*\$?\w+\s*[-+*/]?=/.test(trimmed)) return true
  if (trimmed.includes('--%')) return true
  if (/\\\\|(?<!:)\/\//.test(trimmed)) return true
  if (trimmed.includes('::')) return true
  if (UNSAFE_UNQUOTED_SYNTAX.test(stripPowerShellQuotes(trimmed))) return true
  return false
}
