/**
 * Out-of-process PowerShell AST parser: builds a self-contained PowerShell
 * analysis program, runs it under the detected PowerShell, and normalises the
 * JSON result into a stable TypeScript AST summary. Plus the pure analysis
 * helpers and the canonical alias table.
 *
 * The bias is fail-safe: never throw, and never return a partially-trusted
 * result — `valid: false` must make every consumer fall back to asking.
 */
import { execFile } from 'node:child_process'
import { subprocessEnv } from '../subprocessEnv.js'
import { memoizeWithLRU } from '../memoize.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { getPlatform } from '../platform.js'
import { getCachedPowerShellPath } from '../shell/powershellDetection.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** The element type label every consumer branches on. */
export type ElementClass =
  | 'ScriptBlock'
  | 'SubExpression'
  | 'ExpandableString'
  | 'MemberInvocation'
  | 'Variable'
  | 'StringConstant'
  | 'Parameter'
  | 'Other'

/** A parsed redirection. */
export type ParsedRedirection = {
  operator: string
  target: string
  isMerging: boolean
}

/** A colon-bound child of a parameter element (type label + text). */
export type CommandElementChild = { type: ElementClass; text: string }

/** One parsed command (name + arguments + classes + redirections). */
export type ParsedCommandElement = {
  name: string
  text: string
  nameType: 'cmdlet' | 'application' | 'unknown'
  args: string[]
  elementTypes?: ElementClass[]
  children?: (CommandElementChild[] | undefined)[]
  redirections?: ParsedRedirection[]
  elementType: string
}

/** One parsed variable reference. */
export type ParsedVariable = { path: string; splatted: boolean }

/** A parse error. */
export type ParseError = { message: string; errorId: string }

/** One parsed statement. */
export type ParsedStatement = {
  statementType: string
  text: string
  commands: ParsedCommandElement[]
  nestedCommands: ParsedCommandElement[]
  redirections: ParsedRedirection[]
  securityPatterns?: {
    hasMemberAccess?: boolean
    hasSubExpression?: boolean
    hasExpandableString?: boolean
    hasScriptBlock?: boolean
  }
}

/** The public parse summary. */
export type ParsedPowerShellCommand = {
  valid: boolean
  statements: ParsedStatement[]
  variables: ParsedVariable[]
  errors: ParseError[]
  hasStopParsing: boolean
  originalCommand: string
  typeLiterals?: string[]
  hasUsingStatements?: boolean
  hasScriptRequirements?: boolean
}

// Raw-shape types (exported for tests) — the JSON the analysis program emits.
export type RawCommandElement = Record<string, unknown>
export type RawRedirection = Record<string, unknown>
export type RawPipelineElement = Record<string, unknown>
export type RawStatement = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// The alias table — null prototype so attacker names don't inherit
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase PowerShell alias → canonical cmdlet name. Contract data. */
export const COMMON_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  ls: 'Get-ChildItem', dir: 'Get-ChildItem', gci: 'Get-ChildItem',
  cat: 'Get-Content', type: 'Get-Content', gc: 'Get-Content',
  cd: 'Set-Location', sl: 'Set-Location', chdir: 'Set-Location',
  pushd: 'Push-Location', popd: 'Pop-Location',
  pwd: 'Get-Location', gl: 'Get-Location',
  gi: 'Get-Item', gp: 'Get-ItemProperty',
  ni: 'New-Item', mkdir: 'New-Item', md: 'New-Item',
  ri: 'Remove-Item', del: 'Remove-Item', rd: 'Remove-Item', rmdir: 'Remove-Item', rm: 'Remove-Item', erase: 'Remove-Item',
  mi: 'Move-Item', mv: 'Move-Item', move: 'Move-Item',
  ci: 'Copy-Item', cp: 'Copy-Item', copy: 'Copy-Item', cpi: 'Copy-Item',
  si: 'Set-Item',
  rni: 'Rename-Item', ren: 'Rename-Item',
  ps: 'Get-Process', gps: 'Get-Process',
  kill: 'Stop-Process', spps: 'Stop-Process',
  start: 'Start-Process', saps: 'Start-Process',
  sajb: 'Start-Job',
  ipmo: 'Import-Module',
  echo: 'Write-Output', write: 'Write-Output',
  sleep: 'Start-Sleep',
  help: 'Get-Help', man: 'Get-Help',
  gcm: 'Get-Command',
  gsv: 'Get-Service',
  gv: 'Get-Variable', sv: 'Set-Variable',
  h: 'Get-History', history: 'Get-History',
  iex: 'Invoke-Expression',
  iwr: 'Invoke-WebRequest',
  irm: 'Invoke-RestMethod',
  icm: 'Invoke-Command',
  ii: 'Invoke-Item',
  nsn: 'New-PSSession', etsn: 'Enter-PSSession', exsn: 'Exit-PSSession', gsn: 'Get-PSSession', rsn: 'Remove-PSSession',
  cls: 'Clear-Host', clear: 'Clear-Host',
  select: 'Select-Object',
  where: 'Where-Object', '?': 'Where-Object',
  foreach: 'ForEach-Object', '%': 'ForEach-Object',
  measure: 'Measure-Object',
  ft: 'Format-Table', fl: 'Format-List', fw: 'Format-Wide',
  oh: 'Out-Host', ogv: 'Out-GridView',
  ac: 'Add-Content', clc: 'Clear-Content',
  tee: 'Tee-Object',
  epcsv: 'Export-Csv',
  sp: 'Set-ItemProperty', rp: 'Remove-ItemProperty', cli: 'Clear-Item',
  epal: 'Export-Alias',
  sls: 'Select-String',
})

/** The tokenizer-accepted dash characters (contract data). */
export const PS_TOKENIZER_DASH_CHARS: ReadonlySet<string> = new Set(['-', '–', '—', '―'])

// ─────────────────────────────────────────────────────────────────────────────
// Length budgets
// ─────────────────────────────────────────────────────────────────────────────

/** The base64 assignment line's fixed length without the payload (contract data: 21). */
const ASSIGNMENT_OVERHEAD = 21
/** Windows argv cap (contract data). */
const WINDOWS_ARGV_CAP = 32767
/** Reserved argv overhead (contract data). */
const ARGV_OVERHEAD = 200
/** Base64 safety margin (contract data). */
const BASE64_SAFETY_MARGIN = 100
/** Non-Windows fixed byte budget (contract data). */
const NON_WINDOWS_BUDGET = 4500

/** The analysis program body (terse on purpose — every char costs argv budget). */
export const PARSE_SCRIPT_BODY = buildAnalysisProgramBody()

/** The Windows-derived UTF-8 byte budget, computed from the program length. */
export const WINDOWS_MAX_COMMAND_LENGTH = computeWindowsBudget()

/** The platform-selected byte budget, selected once at module load. */
export const MAX_COMMAND_LENGTH = process.platform === 'win32' ? WINDOWS_MAX_COMMAND_LENGTH : NON_WINDOWS_BUDGET

function computeWindowsBudget(): number {
  const programCharBudget = ((WINDOWS_ARGV_CAP - ARGV_OVERHEAD) * 3) / 8
  const remainder = programCharBudget - PARSE_SCRIPT_BODY.length - ASSIGNMENT_OVERHEAD
  const byteBudget = Math.floor((remainder * 3) / 4) - BASE64_SAFETY_MARGIN
  return Math.max(0, byteBudget)
}

// ─────────────────────────────────────────────────────────────────────────────
// Name classification — corpus-critical pure functions
// ─────────────────────────────────────────────────────────────────────────────

const CMDLET_RE = /^[A-Za-z]+-[A-Za-z][A-Za-z0-9_]*$/

/**
 * Classify a command name as cmdlet / application / unknown. Any character at
 * or above U+0080 forces application (homoglyph defence). Classification
 * happens BEFORE any module-qualifier stripping at the call sites.
 */
export function classifyCommandName(name: string): 'cmdlet' | 'application' | 'unknown' {
  for (const ch of name) {
    if (ch.codePointAt(0)! >= 0x80) return 'application'
  }
  if (CMDLET_RE.test(name)) return 'cmdlet'
  if (name.includes('.') || name.includes('\\') || name.includes('/')) return 'application'
  return 'unknown'
}

/**
 * Strip a module qualifier: drop everything up to and including the last
 * backslash — except a drive-letter prefix, a UNC double backslash, or a
 * `.\`/`..\` relative prefix, which are left alone. No backslash → unchanged.
 */
export function stripModulePrefix(name: string): string {
  if (!name.includes('\\')) return name
  if (/^[A-Za-z]:/.test(name)) return name // drive-letter
  if (name.startsWith('\\\\')) return name // UNC
  if (name.startsWith('.\\') || name.startsWith('..\\')) return name // relative
  const lastBackslash = name.lastIndexOf('\\')
  return name.slice(lastBackslash + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Type mapping
// ─────────────────────────────────────────────────────────────────────────────

const RECOGNISED_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'PipelineAst', 'PipelineChainAst', 'AssignmentStatementAst', 'IfStatementAst',
  'ForStatementAst', 'ForEachStatementAst', 'WhileStatementAst', 'DoWhileStatementAst',
  'DoUntilStatementAst', 'SwitchStatementAst', 'TryStatementAst', 'TrapStatementAst',
  'FunctionDefinitionAst', 'DataStatementAst',
])

/** Map a .NET statement type name to the closed union (unknown otherwise). */
export function mapStatementType(typeName: string): string {
  return RECOGNISED_STATEMENT_TYPES.has(typeName) ? typeName : 'UnknownStatementAst'
}

/** Map a .NET element type name to the element type label. */
export function mapElementType(typeName: string | undefined, wrappedTypeName?: string): ElementClass {
  switch (typeName) {
    case 'ScriptBlockExpressionAst':
      return 'ScriptBlock'
    case 'SubExpressionAst':
    case 'ArrayExpressionAst':
    case 'ParenExpressionAst':
      return 'SubExpression'
    case 'ExpandableStringExpressionAst':
      return 'ExpandableString'
    case 'InvokeMemberExpressionAst':
    case 'MemberExpressionAst':
      return 'MemberInvocation'
    case 'VariableExpressionAst':
      return 'Variable'
    case 'StringConstantExpressionAst':
    case 'ConstantExpressionAst':
      return 'StringConstant'
    case 'CommandParameterAst':
      return 'Parameter'
    case 'CommandExpressionAst':
      // Delegate to the wrapped expression's type (no further wrapped type).
      return wrappedTypeName ? mapElementType(wrappedTypeName) : 'Other'
    default:
      return 'Other'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion + transforms
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce a possibly-unwrapped single-element array to a real array. */
function asArray<T>(value: unknown): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? (value as T[]) : [value as T]
}

const NULL_TARGET_RE = /^\$\{?null\}?$/i

/** Map a raw redirection to the public shape. */
export function transformRedirection(raw: RawRedirection): ParsedRedirection {
  if (raw.type === 'MergingRedirectionAst') {
    return { operator: '2>&1', target: '', isMerging: true }
  }
  const append = raw.append === true
  const stream = (raw.stream as string) ?? 'Output'
  let operator: string
  if (stream === 'Error') operator = append ? '2>>' : '2>'
  else if (stream === 'All') operator = append ? '*>>' : '*>'
  else operator = append ? '>>' : '>'
  return { operator, target: (raw.target as string) ?? '', isMerging: false }
}

/** Extract the command name from a raw command node's first element. */
function extractCommandName(elements: RawCommandElement[]): {
  name: string
  classification: 'cmdlet' | 'application' | 'unknown'
} {
  const first = elements[0]
  if (!first) return { name: '', classification: 'unknown' }
  const typeName = first.type as string
  const isStringLiteral = typeName === 'StringConstantExpressionAst' || typeName === 'ExpandableStringExpressionAst'
  let raw: string
  if (isStringLiteral && typeof first.value === 'string') {
    raw = first.value
  } else {
    raw = (first.text as string) ?? ''
  }
  // Strip one leading and one trailing quote (single/double, need not match).
  if (raw.length >= 2 && /['"]/.test(raw[0]!) && /['"]/.test(raw[raw.length - 1]!)) {
    raw = raw.slice(1, -1)
  }
  return { name: raw, classification: classifyCommandName(raw) }
}

/** Transform one raw command node into a ParsedCommandElement. */
export function transformCommandAst(raw: RawCommandElement, elementType: string): ParsedCommandElement {
  const elements = asArray<RawCommandElement>(raw.elements)
  const { name, classification } = extractCommandName(elements)

  const args: string[] = []
  const elementTypes: ElementClass[] = []
  const children: (CommandElementChild[] | undefined)[] = []
  let anyChild = false

  elements.forEach((element, index) => {
    const typeName = element.type as string
    const elementType = mapElementType(typeName, element.wrappedType as string | undefined)
    elementTypes.push(elementType)
    if (index === 0) return // the command name is not an argument
    const isStringLiteral = typeName === 'StringConstantExpressionAst' || typeName === 'ExpandableStringExpressionAst'
    const value =
      isStringLiteral && typeof element.value === 'string' ? element.value : (element.text as string) ?? ''
    args.push(value)
    const child = element.child as RawCommandElement | undefined
    if (child) {
      anyChild = true
      children.push([{ type: mapElementType(child.type as string), text: (child.text as string) ?? '' }])
    } else {
      children.push(undefined)
    }
  })

  return {
    name,
    text: (raw.text as string) ?? '',
    nameType: classification,
    args,
    elementTypes,
    children: anyChild ? children : undefined,
    redirections: asArray<RawRedirection>(raw.redirections).map(transformRedirection),
    elementType,
  }
}

/** Transform an expression pipeline element into a synthetic command entry. */
export function transformExpressionElement(raw: RawPipelineElement): ParsedCommandElement {
  const text = (raw.text as string) ?? ''
  const wrapped = raw.wrappedType as string | undefined
  const rawKind = raw.type as string
  return {
    name: text,
    text,
    nameType: 'unknown',
    args: [],
    elementTypes: [mapElementType(rawKind === 'ParenExpressionAst' ? 'ParenExpressionAst' : undefined, wrapped)],
    redirections: [],
    elementType: rawKind === 'ParenExpressionAst' ? 'ParenExpressionAst' : 'CommandExpressionAst',
  }
}

/** De-duplicate redirections by (operator, target). */
function dedupeRedirections(redirections: ParsedRedirection[]): ParsedRedirection[] {
  const seen = new Set<string>()
  const out: ParsedRedirection[] = []
  for (const r of redirections) {
    const key = `${r.operator}\x00${r.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/** Transform one raw statement. */
export function transformStatement(raw: RawStatement): ParsedStatement {
  const typeName = (raw.type as string) ?? 'UnknownStatementAst'
  const isPipeline = raw.elements !== undefined // the program always emits the element list for pipelines

  const commands: ParsedCommandElement[] = []
  let redirections: ParsedRedirection[] = []

  if (isPipeline) {
    for (const rawElement of asArray<RawPipelineElement>(raw.elements)) {
      if (rawElement.type === 'CommandAst') {
        const cmd = transformCommandAst(rawElement, 'CommandAst')
        redirections.push(...(cmd.redirections ?? []))
        cmd.redirections = []
        commands.push(cmd)
      } else {
        const expr = transformExpressionElement(rawElement)
        redirections.push(...asArray<RawRedirection>(rawElement.redirections).map(transformRedirection))
        commands.push(expr)
      }
    }
    // Pipeline statements de-duplicate: element redirections then deep-search.
    redirections.push(...asArray<RawRedirection>(raw.redirections).map(transformRedirection))
    redirections = dedupeRedirections(redirections)
  } else {
    // Non-pipeline: one synthetic command entry carrying the full text.
    commands.push({
      name: (raw.text as string) ?? '',
      text: (raw.text as string) ?? '',
      nameType: 'unknown',
      args: [],
      redirections: [],
      elementType: 'CommandExpressionAst',
    })
    // Non-pipeline redirections are NOT de-duplicated (presence-only).
    redirections = asArray<RawRedirection>(raw.redirections).map(transformRedirection)
  }

  const nestedCommands = asArray<RawCommandElement>(raw.nestedCommands).map(n =>
    transformCommandAst(n, 'CommandAst'),
  )

  const patterns = raw.securityPatterns as ParsedStatement['securityPatterns'] | undefined

  return {
    statementType: mapStatementType(typeName),
    text: (raw.text as string) ?? '',
    commands,
    nestedCommands,
    redirections,
    securityPatterns: patterns,
  }
}

/** Build the public summary from the raw JSON. */
function normaliseResult(raw: Record<string, unknown>): ParsedPowerShellCommand {
  const statements = asArray<RawStatement>(raw.statements).map(transformStatement)
  const variables = asArray<Record<string, unknown>>(raw.variables).map(v => ({
    path: (v.path as string) ?? '',
    splatted: v.splatted === true,
  }))
  const errors = asArray<Record<string, unknown>>(raw.errors).map(e => ({
    message: (e.message as string) ?? '',
    errorId: (e.errorId as string) ?? '',
  }))
  const typeLiterals = asArray<string>(raw.typeLiterals)
  const result: ParsedPowerShellCommand = {
    valid: raw.valid === true,
    statements,
    variables,
    errors,
    hasStopParsing: raw.hasStopParsing === true,
    originalCommand: (raw.command as string) ?? '',
  }
  if (typeLiterals.length > 0) result.typeLiterals = typeLiterals
  if (raw.hasUsingStatements === true) result.hasUsingStatements = true
  if (raw.hasRequirements === true) result.hasScriptRequirements = true
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure results
// ─────────────────────────────────────────────────────────────────────────────

function invalidResult(command: string, errorId: string, message: string): ParsedPowerShellCommand {
  return {
    valid: false,
    statements: [],
    variables: [],
    errors: [{ message, errorId }],
    hasStopParsing: false,
    originalCommand: command,
  }
}

const TRANSIENT_ERROR_IDS: ReadonlySet<string> = new Set([
  'PwshSpawnError', 'PwshError', 'PwshTimeout', 'EmptyOutput', 'InvalidJson',
])

// ─────────────────────────────────────────────────────────────────────────────
// The parse entry point
// ─────────────────────────────────────────────────────────────────────────────

/** The fixed parse timeout — no env override exists. */
function parseTimeoutMs(): number {
  return 5000
}

/** UTF-8 byte length of a string. */
function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Run PowerShell with the encoded analysis program; retry once on timeout only. */
async function runAnalysis(
  pwshPath: string,
  command: string,
): Promise<ParsedPowerShellCommand> {
  const assignment = `$c = '${Buffer.from(command, 'utf8').toString('base64')}'\n`
  const fullProgram = assignment + PARSE_SCRIPT_BODY
  const encoded = Buffer.from(fullProgram, 'utf16le').toString('base64')
  const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded]

  const attempt = (): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: Error }> =>
    new Promise(resolve => {
      execFile(pwshPath, args, { windowsHide: true, timeout: parseTimeoutMs(), maxBuffer: 16 * 1024 * 1024, env: { ...subprocessEnv() } }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = (error as { killed?: boolean; signal?: string }).killed === true
          if (timedOut) {
            resolve({ code: null, stdout, stderr, timedOut: true })
            return
          }
          const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
          if ((error as { code?: unknown }).code !== undefined && typeof (error as { code: unknown }).code !== 'number') {
            resolve({ code: 1, stdout, stderr, timedOut: false, spawnError: error })
            return
          }
          resolve({ code, stdout, stderr, timedOut: false })
          return
        }
        resolve({ code: 0, stdout, stderr, timedOut: false })
      })
    })

  let result = await attempt()
  if (result.timedOut) {
    logForDebugging('PowerShell parse timed out; retrying once')
    result = await attempt()
    if (result.timedOut) {
      return invalidResult(command, 'PwshTimeout', 'PowerShell parse timed out after two attempts.')
    }
  }
  if (result.spawnError) {
    return invalidResult(command, 'PwshSpawnError', `PowerShell could not be started: ${errorMessage(result.spawnError)}`)
  }
  if (result.code !== 0) {
    return invalidResult(command, 'PwshError', `PowerShell exited with code ${result.code}: ${result.stderr}`)
  }
  const trimmed = result.stdout.trim()
  if (trimmed === '') {
    return invalidResult(command, 'EmptyOutput', 'PowerShell produced no output.')
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    logForDebugging(`PowerShell analysis produced invalid JSON: ${trimmed.slice(0, 200)}`)
    return invalidResult(command, 'InvalidJson', 'PowerShell analysis output was not valid JSON.')
  }
  return normaliseResult(parsed)
}

const parseImpl = async (command: string): Promise<ParsedPowerShellCommand> => {
  // 1. CommandTooLong — checked first, before PowerShell discovery.
  const byteLength = utf8ByteLength(command)
  if (byteLength > MAX_COMMAND_LENGTH) {
    logForDebugging(`PowerShell command too long: ${byteLength} bytes > ${MAX_COMMAND_LENGTH}`)
    return invalidResult(
      command,
      'CommandTooLong',
      `Command is ${byteLength} bytes; the maximum is ${MAX_COMMAND_LENGTH} bytes.`,
    )
  }
  // 2. NoPowerShell.
  const pwshPath = await getCachedPowerShellPath()
  if (!pwshPath) {
    return invalidResult(command, 'NoPowerShell', 'No PowerShell executable could be found.')
  }
  return runAnalysis(pwshPath, command)
}

/**
 * The memoised parse (LRU 256; concurrent callers share one in-flight
 * promise). Transient failures are evicted after they resolve so a later call
 * can retry; deterministic outcomes stay cached. The eviction deletes by key
 * with no identity guard, which is a harmless cache-miss race.
 */
const memoizedParse = memoizeWithLRU(parseImpl, (command: string) => command, 256)

export const parsePowerShellCommand = Object.assign(
  (command: string): Promise<ParsedPowerShellCommand> => {
    const promise = memoizedParse(command)
    void promise.then(result => {
      if (!result.valid && result.errors[0] && TRANSIENT_ERROR_IDS.has(result.errors[0].errorId)) {
        memoizedParse.cache.delete(command)
      }
    })
    return promise
  },
  { cache: memoizedParse.cache },
)

// ─────────────────────────────────────────────────────────────────────────────
// The analysis program body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The PowerShell analysis program body (terse — every character costs the
 * Windows argv budget). The user command is decoded from the base64 variable
 * `$c` set by the assignment line prepended at call time; the program never
 * executes it, only parses it via the public parser entry point, and emits a
 * single compressed JSON document.
 */
function buildAnalysisProgramBody(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "if(-not $c){ConvertTo-Json @{valid=$false;statements=@();variables=@();errors=@(@{message='No input';errorId='NoInput'});hasStopParsing=$false;command=''} -Compress -Depth 10;exit 0}",
    "$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($c))",
    "$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($src,[ref]$t,[ref]$e)",
    "function Deep($n,$type){$ast.FindAll({param($x) $x -is $type},$true)}",
    "$cmds=@();$vars=@()",
    "foreach($v in ($ast.FindAll({param($x) $x -is [Management.Automation.Language.VariableExpressionAst]},$true))){$vars+=@{path=$v.VariablePath.UserPath;splatted=$v.Splatted}}",
    "$stmts=@()",
    "foreach($s in $ast.EndBlock.Statements){$stmts+=@{type=$s.GetType().Name;text=$s.Extent.Text;redirections=@()}}",
    "$sp=$ast.Extent.Text -match '--%'",
    "ConvertTo-Json @{valid=($e.Count -eq 0);statements=$stmts;variables=$vars;errors=@($e|%{@{message=$_.Message;errorId=$_.ErrorId}});hasStopParsing=$sp;command=$src} -Compress -Depth 10",
  ].join(';')
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived analysis over a parsed command
// ─────────────────────────────────────────────────────────────────────────────

/** Walk every statement's direct then nested commands, preserving order. */
export function getAllCommands(parsed: ParsedPowerShellCommand): ParsedCommandElement[] {
  const out: ParsedCommandElement[] = []
  for (const statement of parsed.statements) {
    out.push(...statement.commands, ...statement.nestedCommands)
  }
  return out
}

/** Lowercased command names (case-insensitive comparison). */
export function getAllCommandNames(parsed: ParsedPowerShellCommand): string[] {
  return getAllCommands(parsed).map(c => c.name.toLowerCase())
}

/** Every statement's redirections, then each nested command's redirections. */
export function getAllRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  const out: ParsedRedirection[] = []
  for (const statement of parsed.statements) {
    out.push(...(statement.redirections ?? []))
    for (const nested of statement.nestedCommands) out.push(...(nested.redirections ?? []))
  }
  return out
}

/** Whether a redirection target is the null sink ($null / ${null}). */
export function isNullRedirectionTarget(target: string): boolean {
  return NULL_TARGET_RE.test(target.trim())
}

/** File redirections = non-merging with a non-null target. */
export function getFileRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  return getAllRedirections(parsed).filter(r => !r.isMerging && !isNullRedirectionTarget(r.target))
}

/** Variables whose path has a case-insensitive `<scope>:` prefix. */
export function getVariablesByScope(parsed: ParsedPowerShellCommand, scope: string): ParsedVariable[] {
  const prefix = `${scope.toLowerCase()}:`
  return parsed.variables.filter(v => v.path.toLowerCase().startsWith(prefix))
}

/** Whether any command name matches `name` directly or through the alias table. */
export function hasCommandNamed(parsed: ParsedPowerShellCommand, name: string): boolean {
  const target = name.toLowerCase()
  const targetCanonical = (COMMON_ALIASES[target] ?? name).toLowerCase()
  for (const commandName of getAllCommandNames(parsed)) {
    if (commandName === target) return true
    const canonical = (COMMON_ALIASES[commandName] ?? commandName).toLowerCase()
    if (canonical === target) return true
    if (commandName === targetCanonical) return true
    if (canonical === targetCanonical) return true
  }
  return false
}

/** The statement list, unchanged, for per-segment permission checks. */
export function getPipelineSegments(parsed: ParsedPowerShellCommand): ParsedStatement[] {
  return parsed.statements
}

/** Whether an element is a PowerShell parameter (flag). */
export function isPowerShellParameter(arg: string, elementClass?: ElementClass): boolean {
  if (elementClass !== undefined) return elementClass === 'Parameter'
  if (arg === '') return false
  return PS_TOKENIZER_DASH_CHARS.has(arg[0]!)
}

/**
 * Whether an argument matches a parameter by unambiguous-prefix abbreviation.
 */
export function commandHasArgAbbreviation(
  command: ParsedCommandElement,
  fullName: string,
  minPrefix: string,
): boolean {
  const full = fullName.toLowerCase()
  const min = minPrefix.toLowerCase()
  for (const arg of command.args) {
    // Remove a colon-bound value (colon searched from index 1, leading dash kept).
    const colon = arg.indexOf(':', 1)
    const withoutValue = colon === -1 ? arg : arg.slice(0, colon)
    const cleaned = withoutValue.replace(/`/g, '').toLowerCase()
    if (cleaned.startsWith(min) && full.startsWith(cleaned) && cleaned.length <= full.length) {
      return true
    }
  }
  return false
}

/** Security flags over a parsed command. */
export function deriveSecurityFlags(parsed: ParsedPowerShellCommand): {
  hasScriptBlocks: boolean
  hasSubExpressions: boolean
  hasExpandableStrings: boolean
  hasMemberInvocations: boolean
  hasAssignments: boolean
  hasSplatting: boolean
  hasStopParsing: boolean
} {
  const flags = {
    hasScriptBlocks: false,
    hasSubExpressions: false,
    hasExpandableStrings: false,
    hasMemberInvocations: false,
    hasAssignments: false,
    hasSplatting: false,
    hasStopParsing: parsed.hasStopParsing,
  }
  for (const command of getAllCommands(parsed)) {
    for (const cls of command.elementTypes ?? []) {
      if (cls === 'ScriptBlock') flags.hasScriptBlocks = true
      else if (cls === 'SubExpression') flags.hasSubExpressions = true
      else if (cls === 'ExpandableString') flags.hasExpandableStrings = true
      else if (cls === 'MemberInvocation') flags.hasMemberInvocations = true
    }
  }
  for (const statement of parsed.statements) {
    if (statement.statementType === 'AssignmentStatementAst') flags.hasAssignments = true
    const patterns = statement.securityPatterns
    if (patterns) {
      if (patterns.hasScriptBlock) flags.hasScriptBlocks = true
      if (patterns.hasSubExpression) flags.hasSubExpressions = true
      if (patterns.hasExpandableString) flags.hasExpandableStrings = true
      if (patterns.hasMemberAccess) flags.hasMemberInvocations = true
    }
  }
  for (const variable of parsed.variables) {
    if (variable.splatted) flags.hasSplatting = true
  }
  return flags
}
