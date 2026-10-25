import { createHash } from 'node:crypto'
import { logForDebugging } from '../debug.js'
import { lspFamilyMatches } from '../../services/lsp/toolFamily.js'
import { getRegisteredHooks } from '../../bootstrap/state.js'
import { matcherShape, ruleArgumentOf, ruleClausesOf } from './matcherGrammar.js'
import { hookMatchValue, type HookEvent, type HookPayload } from './contract.js'
import type { AppState } from '../../state/AppState.js'
import type { HookEntry } from '../settings/types.js'
import { hookEntryText, hookKindOf } from '../../schemas/hooks.js'
import { logError } from '../log.js'
import { pathMatchesRulePattern } from '../permissions/filesystem.js'
import { matchWildcardPattern, parsePermissionRule } from '../permissions/shellRuleMatching.js'
import { parseForSecurity, splitCommand, pinnedCommandAnalysis, getAllCommands } from '../permissions/decision/commandAnalysis.js'
import { namesWholeServerOf } from '../permissions/decision/rules.js'
import { webFetchRuleMatches } from '../../tools/WebFetchTool/WebFetchTool.js'
import { MERCURY_CREW_AGENT_TYPE } from '../../tools/AgentTool/constants.js'
import { hooksDisabled, managedHooksOnly, settingsHooksFor, type HookSource, type LayeredHook } from './hooksConfigSnapshot.js'
import { sessionHooksFor, type HookScope } from './sessionHooks.js'

function nameMatches(name: string, value: string): boolean {
  return name === value || lspFamilyMatches(name, value) || namesWholeServerOf(name, value)
}

async function argumentMatches(toolName: string, content: string, input: unknown): Promise<boolean> {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  switch (ruleArgumentOf(toolName)) {
    case 'command': {
      if (typeof fields.command !== 'string') return false
      const rule = parsePermissionRule(content)
      const command = fields.command.trim()
      const matches = (candidate: string): boolean => rule.type === 'exact' ? candidate.trim() === rule.command : matchWildcardPattern(rule.pattern, candidate.trim())
      if (matches(command)) return true
      if (toolName === 'Bash') {
        await parseForSecurity(command)
        return splitCommand(command).some(matches)
      }
      const parsed = await pinnedCommandAnalysis.parsePowerShellCommand(command)
      return parsed.valid && getAllCommands(parsed).some(part => matches(part.text))
    }
    case 'path': {
      const path = fields.file_path ?? fields.notebook_path ?? fields.path
      return typeof path === 'string' && pathMatchesRulePattern(path, content)
    }
    case 'crewmate':
      return (fields.crewmate_type ?? MERCURY_CREW_AGENT_TYPE) === content
    case 'domain':
      if (typeof fields.url !== 'string') return false
      try {
        return webFetchRuleMatches(content, `domain:${new URL(fields.url).hostname}`)
      } catch {
        return false
      }
    default:
      return false
  }
}

export async function matchesPattern(value: string, matcher: string, input?: unknown): Promise<boolean> {
  const shape = matcherShape(matcher)
  if (shape === 'everything') return true
  if (shape === 'names') return matcher.split('|').some(name => nameMatches(name, value))
  if (shape === 'rules') {
    for (const clause of ruleClausesOf(matcher) ?? []) {
      if (nameMatches(clause.toolName, value) && (clause.ruleContent === undefined || await argumentMatches(clause.toolName, clause.ruleContent, input))) return true
    }
    return false
  }
  try {
    return new RegExp(matcher).test(value)
  } catch {
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

export type MatchedHook = { id: string; event: HookEvent; entry: HookEntry; source: HookSource }

function sourceKey(source: HookSource): string {
  switch (source.kind) {
    case 'settings':
      return ''
    case 'extension':
      return `extension\0${source.root}`
    case 'skill':
      return `skill\0${source.root}`
    case 'agent':
      return `agent\0${source.type}`
  }
}

function hookIdentity(hook: LayeredHook): string {
  const { entry } = hook
  return [hook.event, sourceKey(hook.source), hookKindOf(entry), hookEntryText(entry), entry.match ?? ''].join('\0')
}

function hookId(hook: LayeredHook): string {
  return createHash('sha1').update(hookIdentity(hook)).digest('hex').slice(0, 16)
}

const spent = new Set<string>()

export function markHookSpent(id: string, scope: HookScope): void {
  spent.add(`${scope.sessionId}\0${id}`)
}

function isHookSpent(id: string, scope: HookScope): boolean {
  return spent.has(`${scope.sessionId}\0${id}`)
}

export function claimOnceHook(id: string, scope: HookScope): boolean {
  if (isHookSpent(id, scope)) return false
  markHookSpent(id, scope)
  return true
}

export function forgetSpentHooks(): void {
  spent.clear()
}

function extensionHooksFor(event: HookEvent): LayeredHook[] {
  const registered = getRegisteredHooks()?.[event]
  if (!registered) return []
  const out: LayeredHook[] = []
  for (const matcher of registered) {
    if (!('extensionRoot' in matcher)) continue
    const source: HookSource = { kind: 'extension', name: matcher.extensionName, id: matcher.extensionId, root: matcher.extensionRoot }
    for (const entry of matcher.hooks) out.push({ event, entry, source })
  }
  return out
}

export function hooksFor(event: HookEvent, scope: HookScope, appState?: AppState): LayeredHook[] {
  if (hooksDisabled()) return []
  const hooks = [...settingsHooksFor(event, scope.cwd)]
  if (managedHooksOnly()) return hooks
  hooks.push(...extensionHooksFor(event))
  if (appState !== undefined) hooks.push(...sessionHooksFor(appState, scope, event))
  return hooks
}

export function hasHooksFor(event: HookEvent, scope: HookScope, appState?: AppState): boolean {
  return hooksFor(event, scope, appState).length > 0
}

export function dedupeHooks(hooks: LayeredHook[]): MatchedHook[] {
  const byIdentity = new Map<string, MatchedHook>()
  for (const hook of hooks) {
    const identity = hookIdentity(hook)
    byIdentity.delete(identity)
    byIdentity.set(identity, { id: hookId(hook), event: hook.event, entry: hook.entry, source: hook.source })
  }
  return [...byIdentity.values()]
}

export async function matchHooks(
  event: HookEvent,
  payload: HookPayload,
  scope: HookScope,
  options: { appState?: AppState } = {},
): Promise<MatchedHook[]> {
  try {
    const candidates = hooksFor(event, scope, options.appState)
    const fields = payload as unknown as Record<string, unknown>
    const value = hookMatchValue(event, fields)
    const matching = await Promise.all(candidates.map(async hook => hook.entry.match === undefined || value === undefined || await matchesPattern(value, hook.entry.match, fields.input)))
    const result = dedupeHooks(candidates.filter((_, i) => matching[i])).filter(hook => !isHookSpent(hook.id, scope))
    logForDebugging(`${event}: ${result.length} hooks matched${value !== undefined ? ` for "${value}"` : ''} (${candidates.length} before deduplication)`, {
      level: 'verbose',
    })
    return result
  } catch (error) {
    logError(new Error('hook matching failed — running no hooks for this event', { cause: error instanceof Error ? error : new Error(String(error)) }))
    return []
  }
}
