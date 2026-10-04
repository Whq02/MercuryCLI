
import { logForDebugging } from '../debug.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
} from './hooksConfigSnapshot.js'
import { getIsNonInteractiveSession, getRegisteredHooks } from '../../bootstrap/state.js'
import { matcherShape } from './matcherGrammar.js'
import { hookEventMatchQuery } from './contract.js'
import type { AppState } from '../../state/AppState.js'
import type { HookEvent, HookInput } from './contract.js'

import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type {
  HookCallback,
  HookCallbackMatcher,
} from '../../types/hooks.js'
import type {
  HookCommand,
  HookMatcher,
  ExtensionHookMatcher,
  SkillHookMatcher,
} from '../settings/types.js'
import {
  permissionRuleValueFromString,
} from '../permissions/permissionRuleParser.js'
import { logError } from '../log.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import {
  getSessionFunctionHooks,
  getSessionHooks,
  type FunctionHook,
  type SessionDerivedHookMatcher,
} from './sessionHooks.js'

export function matchesPattern(matchQuery: string, matcher: string): boolean {
  const shape = matcherShape(matcher)
  if (shape === 'everything') {
    return true
  }
  if (shape === 'names') {
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map(p => p.trim())
      return patterns.includes(matchQuery)
    }
    return matchQuery === matcher
  }

  try {
    const regex = new RegExp(matcher)
    return regex.test(matchQuery)
  } catch {
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

export type IfConditionMatcher = (ifCondition: string) => boolean

const IF_CONDITION_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]

export function eventSupportsIfConditions(event: HookEvent): boolean {
  return IF_CONDITION_EVENTS.includes(event)
}

export async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (!eventSupportsIfConditions(hookInput.hook_event_name)) {
    return undefined
  }
  const toolEventInput = hookInput as Extract<HookInput, { tool_name: string; tool_input: unknown }>

  const toolName = toolEventInput.tool_name
  const tool = tools && findToolByName(tools, toolEventInput.tool_name)
  const input = tool?.inputSchema.safeParse(toolEventInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return ifCondition => {
    const parsed = permissionRuleValueFromString(ifCondition)
    if (parsed.toolName !== toolName) {
      return false
    }
    if (!parsed.ruleContent) {
      return true
    }
    return patternMatcher ? patternMatcher(parsed.ruleContent) : false
  }
}

export type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

export type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  extensionRoot?: string
  extensionId?: string
  skillRoot?: string
  hookSource?: string
}

export function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

export function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.extensionRoot ?? m.skillRoot ?? ''}\0${payload}`
}

export function getHooksConfig(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
): Array<
  | HookMatcher
  | HookCallbackMatcher
  | FunctionHookMatcher
  | ExtensionHookMatcher
  | SkillHookMatcher
  | SessionDerivedHookMatcher
> {
  const hooks: Array<
    | HookMatcher
    | HookCallbackMatcher
    | FunctionHookMatcher
    | ExtensionHookMatcher
    | SkillHookMatcher
    | SessionDerivedHookMatcher
  > = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  const managedOnly = shouldAllowManagedHooksOnly()

  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      if (managedOnly && 'extensionRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionHooks) {
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    const sessionFunctionHooks = getSessionFunctionHooks(
      appState,
      sessionId,
      hookEvent,
    ).get(hookEvent)
    if (sessionFunctionHooks) {
      for (const matcher of sessionFunctionHooks) {
        hooks.push(matcher)
      }
    }
  }

  return hooks
}

export function hasHookForEvent(
  hookEvent: HookEvent,
  appState: AppState | undefined,
  sessionId: string,
): boolean {
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) return true
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) return true
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) return true
  return false
}

function matchQueryForInput(hookInput: HookInput): string | undefined {
  return hookEventMatchQuery(hookInput.hook_event_name, hookInput)
}

const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

function dedupByPayload(
  hooks: MatchedHook[],
  type: string,
  payload: (m: MatchedHook) => string,
): MatchedHook[] {
  return Array.from(
    new Map(
      hooks
        .filter(m => m.hook.type === type)
        .map(m => [hookDedupKey(m, payload(m)), m] as const),
    ).values(),
  )
}

export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): Promise<MatchedHook[]> {
  try {
    const hookMatchers = getHooksConfig(appState, sessionId, hookEvent)
    const matchQuery = matchQueryForInput(hookInput)

    logForDebugging(
      `Getting matching hook commands for ${hookEvent} with query: ${matchQuery}`,
      { level: 'verbose' },
    )
    logForDebugging(`Found ${hookMatchers.length} hook matchers in settings`, {
      level: 'verbose',
    })

    const filteredMatchers = matchQuery
      ? hookMatchers.filter(
          matcher =>
            !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
        )
      : hookMatchers

    const matchedHooks: MatchedHook[] = filteredMatchers.flatMap(matcher => {
      const extensionRoot =
        'extensionRoot' in matcher ? matcher.extensionRoot : undefined
      const extensionId = 'extensionId' in matcher ? matcher.extensionId : undefined
      const skillRoot = 'skillRoot' in matcher ? matcher.skillRoot : undefined
      const hookSource = extensionRoot
        ? 'extensionName' in matcher
          ? `extension:${matcher.extensionName}`
          : 'extension'
        : skillRoot
          ? 'skillName' in matcher
            ? `skill:${matcher.skillName}`
            : 'skill'
          : 'settings'
      return matcher.hooks.map(hook => ({
        hook,
        extensionRoot,
        extensionId,
        skillRoot,
        hookSource,
      }))
    })

    if (
      matchedHooks.every(
        m => m.hook.type === 'callback' || m.hook.type === 'function',
      )
    ) {
      return matchedHooks
    }

    const uniqueHooks = [
      ...dedupByPayload(
        matchedHooks,
        'command',
        m =>
          `${(m.hook as HookCommand & { shell?: string }).shell ?? DEFAULT_HOOK_SHELL}\0${(m.hook as { command: string }).command}\0${getIfCondition(m.hook as { if?: string })}`,
      ),
      ...dedupByPayload(
        matchedHooks,
        'prompt',
        m =>
          `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
      ),
      ...dedupByPayload(
        matchedHooks,
        'agent',
        m =>
          `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
      ),
      ...dedupByPayload(
        matchedHooks,
        'http',
        m =>
          `${(m.hook as { url: string }).url}\0${getIfCondition(m.hook as { if?: string })}`,
      ),
      ...matchedHooks.filter(m => m.hook.type === 'callback'),
      ...matchedHooks.filter(m => m.hook.type === 'function'),
    ]

    const hasIfCondition = uniqueHooks.some(
      h =>
        (h.hook.type === 'command' ||
          h.hook.type === 'prompt' ||
          h.hook.type === 'agent' ||
          h.hook.type === 'http') &&
        (h.hook as { if?: string }).if,
    )
    const ifMatcher = hasIfCondition
      ? await prepareIfConditionMatcher(hookInput, tools)
      : undefined
    const ifFilteredHooks = uniqueHooks.filter(h => {
      if (
        h.hook.type !== 'command' &&
        h.hook.type !== 'prompt' &&
        h.hook.type !== 'agent' &&
        h.hook.type !== 'http'
      ) {
        return true
      }
      const ifCondition = (h.hook as { if?: string }).if
      if (!ifCondition) {
        return true
      }
      if (!ifMatcher) {
        const skipLine = `hook if condition "${ifCondition}" can never evaluate on ${hookInput.hook_event_name} (no tool input) — hook skipped`
        logForDebugging(skipLine)
        if (getIsNonInteractiveSession()) {
          process.stderr.write(`${skipLine}\n`)
        }
        return false
      }
      if (ifMatcher(ifCondition)) {
        return true
      }
      logForDebugging(
        `Skipping hook due to if condition "${ifCondition}" not matching`,
      )
      return false
    })

    const filteredHooks =
      hookEvent === 'SessionStart' || hookEvent === 'Setup'
        ? ifFilteredHooks.filter(h => {
            if (h.hook.type === 'http') {
              logForDebugging(
                `Skipping HTTP hook ${(h.hook as { url: string }).url} — HTTP hooks are not supported for ${hookEvent}`,
              )
              return false
            }
            return true
          })
        : ifFilteredHooks

    logForDebugging(
      `Matched ${filteredHooks.length} unique hooks for query "${matchQuery || 'no match query'}" (${matchedHooks.length} before deduplication)`,
      { level: 'verbose' },
    )
    return filteredHooks
  } catch (error) {
    logError(
      new Error('hook matching failed — running no hooks for this event', {
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    return []
  }
}
