/**
 * The PowerShell permission pipeline. Its defining property is collect-then-
 * reduce: every post-parse check contributes a verdict to one collection, then
 * a single reduction applies deny > ask > allow > passthrough (first of each
 * behaviour winning). This is the fix for a whole bug class — an ask from an
 * early check can never mask a deny from a later one. Do not restore early
 * returns inside the post-parse band.
 */
import type { ToolUseContext, ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { ShellPermissionRule } from '../../utils/permissions/shellRuleMatching.js'
import {
  parsePermissionRule,
  matchWildcardPattern,
  suggestionForExactCommand,
} from '../../utils/permissions/shellRuleMatching.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/decision/rules.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import {
  getPipelineSegments,
  getAllCommands,
  hasCommandNamed,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import { containsVulnerableUncPath } from '../../utils/shell/readOnlyCommandValidation.js'
import { powershellCommandIsSafe } from './powershellSecurity.js'
import {
  isReadOnlyCommand,
  isProvablySafeStatement,
  isAllowlistedCommand,
  isSafeOutputCommand,
  isCwdChangingCmdlet,
  resolveToCanonical,
  argLeaksValue,
} from './readOnlyValidation.js'
import { checkPathConstraints, isDangerousRemovalRawPath, dangerousRemovalDeny } from './pathValidation.js'
import { checkPermissionMode, isSymlinkCreatingCommand } from './modeValidation.js'
import { isGitInternalPathPS, isDotGitPathPS } from './gitSafety.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'

const TOOL_NAME = 'PowerShell'

/** Delegates to the shared rule parser. */
export function powershellPermissionRule(ruleString: string): ShellPermissionRule {
  return parsePermissionRule(ruleString)
}

// ── rule matching ────────────────────────────────────────────────────

/** Match a rule against a candidate string (case-insensitive). */
function ruleMatches(rule: ShellPermissionRule, candidate: string, mode: 'exact' | 'prefix'): boolean {
  const c = candidate.toLowerCase()
  switch (rule.type) {
    case 'exact':
      return c === rule.command.toLowerCase()
    case 'prefix': {
      const p = rule.prefix.toLowerCase()
      return mode === 'exact' ? c === p : c === p || c.startsWith(p + ' ')
    }
    case 'wildcard':
      return mode === 'exact' ? false : matchWildcardPattern(rule.pattern, candidate, true)
  }
}

/** Canonicalise a command's first token + normalise the remainder to single spaces. */
function canonicaliseCommand(command: string): string {
  const trimmed = command.trim()
  const match = trimmed.match(/^(\S+)(\s+)([\s\S]*)$/)
  if (!match) return resolveToCanonical(stripModule(trimmed))
  const canonicalName = resolveToCanonical(stripModule(match[1] as string))
  return `${canonicalName} ${(match[3] as string).replace(/\s+/g, ' ')}`
}

function stripModule(name: string): string {
  return pinnedCommandAnalysis.stripModulePrefix(name)
}

/** Look up rules of a behaviour and test them against the three candidates. */
function matchRules(command: string, context: ToolPermissionContext, behavior: 'deny' | 'ask' | 'allow', mode: 'exact' | 'prefix'): string | null {
  const rules = getRuleByContentsForToolName(context, TOOL_NAME, behavior)
  if (rules.size === 0) return null
  const raw = command.trim()
  const canonical = canonicaliseCommand(command)
  const stripModuleForRule = behavior === 'deny' || behavior === 'ask'
  for (const [ruleContent] of rules) {
    const parsed = parsePermissionRule(ruleContent)
    if (ruleMatches(parsed, raw, mode) || ruleMatches(parsed, canonical, mode)) return ruleContent
    if (stripModuleForRule) {
      const ruleCanonical = parsePermissionRule(canonicaliseRuleFirstToken(ruleContent))
      if (ruleMatches(ruleCanonical, canonical, mode)) return ruleContent
    }
  }
  return null
}

function canonicaliseRuleFirstToken(ruleContent: string): string {
  const match = ruleContent.match(/^(\S+)(\s+)([\s\S]*)$/)
  if (!match) return resolveToCanonical(stripModule(ruleContent))
  return `${resolveToCanonical(stripModule(match[1] as string))} ${(match[3] as string).replace(/\s+/g, ' ')}`
}

function ruleReason(context: ToolPermissionContext, ruleContent: string, behavior: 'deny' | 'ask' | 'allow'): PermissionDecisionReason {
  const rule = getRuleByContentsForToolName(context, TOOL_NAME, behavior).get(ruleContent)
  return { type: 'rule', rule: rule ?? { source: 'localSettings', ruleBehavior: behavior, ruleValue: { toolName: TOOL_NAME, ruleContent } } }
}

/** Exact-command suggestions — nothing for a newline or literal `*`. */
function exactSuggestions(command: string): ReturnType<typeof suggestionForExactCommand> {
  if (command.includes('\n') || command.includes('*')) return []
  return suggestionForExactCommand(TOOL_NAME, command.trim())
}

/** The exact-match permission check. */
export function powershellToolCheckExactMatchPermission(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult {
  const command = input.command.trim()
  const deny = matchRules(command, toolPermissionContext, 'deny', 'exact')
  if (deny) return { behavior: 'deny', message: `${TOOL_NAME}(${command}) is blocked by a deny rule.`, decisionReason: ruleReason(toolPermissionContext, deny, 'deny') }
  const ask = matchRules(command, toolPermissionContext, 'ask', 'exact')
  if (ask) return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(toolPermissionContext, ask, 'ask') }
  const allow = matchRules(command, toolPermissionContext, 'allow', 'exact')
  if (allow) return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(toolPermissionContext, allow, 'allow') }
  return { behavior: 'passthrough', message: `${command} requires approval.`, suggestions: exactSuggestions(command) }
}

/** The full permission check (exact then prefix). */
export function powershellToolCheckPermission(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult {
  const exact = powershellToolCheckExactMatchPermission(input, toolPermissionContext)
  if (exact.behavior === 'deny' || exact.behavior === 'ask') return exact
  const command = input.command.trim()
  const deny = matchRules(command, toolPermissionContext, 'deny', 'prefix')
  if (deny) return { behavior: 'deny', message: `${TOOL_NAME} deny rule matched.`, decisionReason: ruleReason(toolPermissionContext, deny, 'deny') }
  const ask = matchRules(command, toolPermissionContext, 'ask', 'prefix')
  if (ask) return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(toolPermissionContext, ask, 'ask') }
  if (exact.behavior === 'allow') return exact
  const allow = matchRules(command, toolPermissionContext, 'allow', 'prefix')
  if (allow) return { behavior: 'allow', updatedInput: input, decisionReason: ruleReason(toolPermissionContext, allow, 'allow') }
  return { behavior: 'passthrough', message: `${command} requires approval.`, suggestions: exactSuggestions(command) }
}

// ── the entry point ──────────────────────────────────────────────────

const GIT_WRITER = new Set(['new-item', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'rename-item', 'expand-archive', 'invoke-webrequest', 'invoke-restmethod', 'tee-object', 'export-csv', 'export-clixml'])
const ARCHIVE_EXTRACTORS = new Set(['tar', 'bsdtar', 'unzip', '7z', '7za', 'gzip', 'gunzip', 'tar.exe', 'bsdtar.exe', 'unzip.exe', '7z.exe', '7za.exe', 'gzip.exe', 'gunzip.exe', 'expand-archive'])

/** The main permission entry. */
export async function powershellToolHasPermission(
  input: { command: string; timeout?: number },
  context: ToolUseContext,
): Promise<PermissionResult> {
  const toolPermissionContext = context.getAppState().toolPermissionContext as ToolPermissionContext
  const command = input.command.trim()

  // Step 0 — empty command.
  if (command === '') return { behavior: 'allow', updatedInput: input, decisionReason: other('Nothing to run.') }

  // Step 1 — parse once.
  const parsed = await pinnedCommandAnalysis.parsePowerShellCommand(command)

  // Step 2 — pre-parse rule checks (run even when parsing fails).
  const exact = powershellToolCheckExactMatchPermission({ command }, toolPermissionContext)
  if (exact.behavior === 'deny') return exact
  const prefixDeny = matchRules(command, toolPermissionContext, 'deny', 'prefix')
  if (prefixDeny) return { behavior: 'deny', message: `${command} is blocked by a deny rule.`, decisionReason: ruleReason(toolPermissionContext, prefixDeny, 'deny') }
  let deferredAsk: PermissionResult | null = null
  const prefixAsk = matchRules(command, toolPermissionContext, 'ask', 'prefix')
  if (prefixAsk) deferredAsk = { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(toolPermissionContext, prefixAsk, 'ask') }
  if (deferredAsk === null && containsVulnerableUncPath(command)) {
    deferredAsk = { behavior: 'ask', message: 'The command contains a UNC path that could trigger network requests.' }
  }
  if (!parsed.valid && deferredAsk === null && exact.behavior === 'allow') {
    const firstToken = command.split(/\s+/)[0] ?? ''
    if (pinnedCommandAnalysis.classifyCommandName(firstToken) !== 'application') return exact
  }

  // Step 3 — parse failure.
  if (!parsed.valid) {
    const fragmentDeny = fragmentDenyScan(command, toolPermissionContext)
    if (fragmentDeny) return fragmentDeny
    if (deferredAsk) return deferredAsk
    const error = parsed.errors[0]?.message ?? 'unknown error'
    return { behavior: 'ask', message: `The command has malformed syntax that cannot be parsed: ${error}` }
  }

  // Step 4 — post-parse: collect, then reduce.
  const collected: PermissionResult[] = []
  const push = (result: PermissionResult | null): void => {
    if (result && result.behavior !== 'passthrough') collected.push(result)
  }
  if (deferredAsk) collected.push(deferredAsk)

  const subcommands = getAllCommands(parsed)
  const segments = getPipelineSegments(parsed)
  const canonicalNames = subcommands.map(c => resolveToCanonical(c.name))
  const totalCommands = subcommands.length
  const hasCd = totalCommands > 1 && subcommands.some(c => isCwdChangingCmdlet(c.name))
  const hasSymlinkCreate = totalCommands > 1 && subcommands.some(c => isSymlinkCreatingCommand({ name: c.name, args: c.args }))
  const hasGit = canonicalNames.includes('git')

  // 2. Security battery.
  const battery = powershellCommandIsSafe(command, parsed)
  if (battery.behavior === 'ask') {
    push({ behavior: 'ask', message: battery.message ?? 'The command carries security-relevant patterns and needs approval.', suggestions: exactSuggestions(command) })
  }
  // 3-4. using / #Requires.
  if (parsed.hasUsingStatements) push({ behavior: 'ask', message: 'A `using` statement may load external code (a module or an assembly).' })
  if (parsed.hasScriptRequirements) push({ behavior: 'ask', message: 'A `#Requires` directive may trigger module loading.' })
  // 5. Resolved-argument provider / UNC scan.
  push(providerUncScan(parsed))
  // 6. Per-sub-command deny/ask rules.
  for (const command_ of subcommands) push(subcommandRuleVerdict(command_, toolPermissionContext))
  // 7. cd + git compound guard.
  if (totalCommands > 1 && hasCd && hasGit) push({ behavior: 'ask', message: 'A compound that mixes a directory change with a git invocation needs approval, because the pairing is the shape of a bare-repository attack.' })
  // 8-10 git guards.
  if (hasGit) {
    if (isCurrentDirectoryBareGitRepo()) push({ behavior: 'ask', message: 'The current directory carries bare-repository indicators (HEAD, objects/, refs/) with no valid .git/HEAD; git may treat it as the repository and run hooks from it.' })
    if (gitInternalWrite(parsed, subcommands)) push({ behavior: 'ask', message: 'The command writes into a git-internal location (HEAD, objects/, refs/, hooks/, .git/) and then runs git — a hook could be planted and executed.' })
    if (subcommands.some(c => ARCHIVE_EXTRACTORS.has(c.name.toLowerCase())) ) push({ behavior: 'ask', message: 'The compound unpacks an archive before running git; an archive can carry the files that make a directory look like a repository root.' })
  }
  // 11. .git/ writes without git.
  if (dotGitWrite(parsed, subcommands)) push({ behavior: 'ask', message: 'The command targets .git/; anything planted there runs at the next git operation.' })
  // 12. Path constraints.
  push(checkPathConstraints({ command }, parsed, toolPermissionContext, hasCd))
  // 13. Exact allow, parse-succeeded.
  if (exact.behavior === 'allow' && subcommands.length > 0 && subcommands.every(c => c.nameType !== 'application') && !subcommands.some(c => argLeaksValue(command, c))) {
    push(exact)
  }
  // 14. Read-only allowlist.
  if (isReadOnlyCommand(command, parsed)) push({ behavior: 'allow', updatedInput: input, decisionReason: other('The whole command is read-only.') })
  // 15. File redirections.
  if (pinnedCommandAnalysis.getFileRedirections(parsed).length > 0) push({ behavior: 'ask', message: 'The command has file redirections that could write to arbitrary paths.', suggestions: exactSuggestions(command) })
  // 16. Permission-mode auto-allow.
  push(checkPermissionMode({ command }, parsed, toolPermissionContext))

  const reduced = reduce(collected)
  if (reduced) return reduced

  // Step 5 — per-sub-command approval collection.
  return perSubcommandApproval(input, command, parsed, segments, subcommands, toolPermissionContext, hasCd, hasSymlinkCreate)
}

/** Reduce the collection by precedence deny > ask > allow (first of each). */
function reduce(collected: PermissionResult[]): PermissionResult | null {
  const deny = collected.find(r => r.behavior === 'deny')
  if (deny) return deny
  const ask = collected.find(r => r.behavior === 'ask')
  if (ask) return ask
  const allow = collected.find(r => r.behavior === 'allow')
  if (allow) return allow
  return null
}

function subcommandRuleVerdict(command: ParsedCommandElement, context: ToolPermissionContext): PermissionResult | null {
  const raw = command.text.trim()
  const canonical = command.name ? `${resolveToCanonical(command.name)} ${command.args.join(' ')}`.trim() : null
  const deny = matchRules(raw, context, 'deny', 'prefix') ?? (canonical ? matchRules(canonical, context, 'deny', 'prefix') : null)
  if (deny) return { behavior: 'deny', message: `A subcommand is blocked by a deny rule.`, decisionReason: ruleReason(context, deny, 'deny') }
  const ask = matchRules(raw, context, 'ask', 'prefix') ?? (canonical ? matchRules(canonical, context, 'ask', 'prefix') : null)
  if (ask) return { behavior: 'ask', message: createPermissionRequestMessage(TOOL_NAME), decisionReason: ruleReason(context, ask, 'ask') }
  return null
}

const PROVIDER_PREFIX = /^(?:[\w.]+\\)?(?:env|hklm|hkcu|function|alias|variable|cert|wsman|registry)(?:::|:)/i
function providerUncScan(parsed: ParsedPowerShellCommand): PermissionResult | null {
  for (const statement of getPipelineSegments(parsed)) {
    for (const command of [...statement.commands, ...statement.nestedCommands]) {
      for (const arg of command.args) {
        let a = arg
        if (/[-–—―]/.test(a[0] ?? '')) { const colon = a.indexOf(':', 1); if (colon !== -1) a = a.slice(colon + 1) }
        a = a.replace(/`/g, '')
        if (PROVIDER_PREFIX.test(a)) return { behavior: 'ask', message: `The argument "${arg}" uses a non-filesystem provider path requiring approval.` }
        if (containsVulnerableUncPath(a)) return { behavior: 'ask', message: `The argument "${arg}" is a UNC path that could trigger network requests.` }
      }
    }
  }
  return null
}

function gitInternalWrite(parsed: ParsedPowerShellCommand, subcommands: ParsedCommandElement[]): boolean {
  for (const command of subcommands) {
    if (GIT_WRITER.has(resolveToCanonical(command.name))) {
      for (const arg of command.args.flatMap(a => a.split(','))) if (isGitInternalPathPS(arg)) return true
    }
    for (const redirect of command.redirections ?? []) if (isGitInternalPathPS(redirect.target)) return true
  }
  for (const redirect of pinnedCommandAnalysis.getFileRedirections(parsed)) if (isGitInternalPathPS(redirect.target)) return true
  return false
}

function dotGitWrite(parsed: ParsedPowerShellCommand, subcommands: ParsedCommandElement[]): boolean {
  for (const command of subcommands) {
    if (GIT_WRITER.has(resolveToCanonical(command.name))) {
      for (const arg of command.args.flatMap(a => a.split(','))) if (isDotGitPathPS(arg)) return true
    }
    for (const redirect of command.redirections ?? []) if (isDotGitPathPS(redirect.target)) return true
  }
  for (const redirect of pinnedCommandAnalysis.getFileRedirections(parsed)) if (isDotGitPathPS(redirect.target)) return true
  return false
}

/** Fragment deny scan for a failed parse. */
function fragmentDenyScan(command: string, context: ToolPermissionContext): PermissionResult | null {
  const collapsed = command.replace(/`\n\s*/g, '').replace(/`/g, '')
  for (const raw of collapsed.split(/[;|\n\r{}()&]/)) {
    let fragment = raw.trim()
    if (fragment === '') continue
    fragment = fragment.replace(/^\$?\w+\s*[-+*/]?=\s*/, '').replace(/^[.&]\s+/, '')
    if (/^['"]/.test(fragment)) fragment = fragment.slice(1).replace(/['"]$/, '')
    const first = fragment.split(/\s+/)[0] ?? ''
    if (resolveToCanonical(first) === 'remove-item') {
      for (const token of fragment.split(/\s+/).slice(1)) {
        if (/^[-–—―]/.test(token)) continue
        if (isDangerousRemovalRawPath(token)) return dangerousRemovalDeny(token)
      }
    }
    const deny = matchRules(fragment, context, 'deny', 'prefix')
    if (deny) return { behavior: 'deny', message: `${command} is blocked by a deny rule.`, decisionReason: ruleReason(context, deny, 'deny') }
  }
  return null
}

/** Step 5 + 5b + 6: per-sub-command approval collection and final verdict. */
function perSubcommandApproval(
  input: { command: string },
  command: string,
  parsed: ParsedPowerShellCommand,
  segments: ParsedPowerShellCommand['statements'],
  subcommands: ParsedCommandElement[],
  context: ToolPermissionContext,
  hasCd: boolean,
  hasSymlinkCreate: boolean,
): PermissionResult {
  const approvalList: string[] = []
  const statementPushed = new Set<unknown>()

  for (const statement of segments) {
    for (const element of statement.commands) {
      if (isSafeOutputCommand(element.name) && element.args.length === 0) continue
      const rule = powershellToolCheckPermission({ command: element.text }, context)
      if (rule.behavior === 'deny') return { behavior: 'deny', message: `A subcommand of "${command}" is blocked by a deny rule.`, decisionReason: rule.decisionReason }
      if (rule.behavior === 'ask') { approvalList.push(element.text); statementPushed.add(statement); continue }
      if (rule.behavior === 'allow' && element.nameType !== 'application' && !hasSymlinkCreate) {
        if (argLeaksValue(command, element)) { approvalList.push(element.text); statementPushed.add(statement) }
        continue
      }
      if (rule.behavior === 'allow') { approvalList.push(element.text); statementPushed.add(statement); continue }
      // built-in allowlist shortcut.
      if (!hasCd && !hasSymlinkCreate && isProvablySafeStatement(statement) && isAllowlistedCommand(element, command)) continue
      approvalList.push(element.text)
      statementPushed.add(statement)
    }
  }

  // Step 5b — fail-closed statement gate.
  for (const statement of segments) {
    if (!isProvablySafeStatement(statement) && !statementPushed.has(statement)) approvalList.push(statement.text)
  }

  // Step 6 — final verdict.
  if (approvalList.length === 0) {
    if (subcommands.some(c => c.elementType === 'ScriptBlock') || parsedHasScriptBlocks(parsed)) {
      return { behavior: 'ask', message: 'What remains is a formatting pipeline whose script-block bodies were never inspected.' }
    }
    return { behavior: 'allow', updatedInput: input, decisionReason: other('Every command in the pipeline cleared on its own.') }
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(TOOL_NAME),
    decisionReason: other('Requires approval.'),
    suggestions: approvalList.flatMap(entry => exactSuggestions(entry)),
  }
}

function parsedHasScriptBlocks(parsed: ParsedPowerShellCommand): boolean {
  return getPipelineSegments(parsed).some(s => s.securityPatterns?.hasScriptBlock === true)
}

function other(reason: string): PermissionDecisionReason {
  return { type: 'other', reason }
}

void hasCommandNamed
