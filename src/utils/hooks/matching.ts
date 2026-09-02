// The hook matcher engine — pattern matching (exact / regex / * / pipe),
// if-condition preparation, the three-source config merge (settings snapshot
// + registered + session), per-event match-query routing, dedup (namespaced
// by extension/skill root), and telemetry counts. Owned Mercury
// module. The R4 parity oracle
// (scripts/hooks) pins the matcher semantics.

import { basename } from 'path'
import { logForDebugging } from '../debug.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
} from './hooksConfigSnapshot.js'
import { getIsNonInteractiveSession, getRegisteredHooks } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { HookEvent, HookInput } from 'src/entrypoints/agentSdkTypes.js'
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
  getLegacyToolNames,
  normalizeLegacyToolName,
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

/**
 * Does this matcher pattern claim the query?
 *
 * Three grammars share one string: empty or `*` claims everything; a string
 * of word characters (optionally `|`-separated) is exact-match against the
 * legacy-normalized name(s); anything else is a regex. The regex lane also
 * tries the query's legacy aliases, so a pattern written against a retired
 * tool spelling keeps matching the renamed tool. An uncompilable regex
 * matches nothing and says so in the debug log.
 */
export function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') {
    return true
  }
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      const patterns = matcher
        .split('|')
        .map(p => normalizeLegacyToolName(p.trim()))
      return patterns.includes(matchQuery)
    }
    return matchQuery === normalizeLegacyToolName(matcher)
  }

  try {
    const regex = new RegExp(matcher)
    if (regex.test(matchQuery)) {
      return true
    }
    for (const legacyName of getLegacyToolNames(matchQuery)) {
      if (regex.test(legacyName)) {
        return true
      }
    }
    return false
  } catch {
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

export type IfConditionMatcher = (ifCondition: string) => boolean

/**
 * The events whose input carries a TOOL dimension — the only events where
 * an `if` condition ("Bash(git *)") has anything to evaluate against
 * (FC-109). One truth: prepareIfConditionMatcher keys off this, and the
 * surfaces that must NAME a dead condition (the runtime skip line, the
 * hook-detail card) read the same predicate.
 */
const IF_CONDITION_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]

export function eventSupportsIfConditions(event: HookEvent): boolean {
  return IF_CONDITION_EVENTS.includes(event)
}

/**
 * Build the `if`-condition evaluator for one hook input. All the costly
 * machinery — resolving the tool, schema-validating its input, tree-sitter
 * for Bash commands — runs a single time in here; what comes back is a
 * cheap closure the caller applies per hook. Non-tool events have no
 * conditions to evaluate and get undefined.
 */
export async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (!eventSupportsIfConditions(hookInput.hook_event_name)) {
    return undefined
  }
  // The predicate IS the tool-dimension truth, but a call through it does
  // not narrow the discriminated union the way the inlined comparisons
  // did — this alias carries the narrowing the guard just established.
  const toolEventInput = hookInput as Extract<HookInput, { tool_name: string; tool_input: unknown }>

  const toolName = normalizeLegacyToolName(toolEventInput.tool_name)
  const tool = tools && findToolByName(tools, toolEventInput.tool_name)
  const input = tool?.inputSchema.safeParse(toolEventInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return ifCondition => {
    const parsed = permissionRuleValueFromString(ifCondition)
    if (normalizeLegacyToolName(parsed.toolName) !== toolName) {
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

/**
 * One matched hook plus the source context that matched it. The
 * extension/skill fields ride along so execution can expand root-relative
 * templates and apply the extension env at spawn time; hookSource feeds
 * attribution in the UI.
 */
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

/**
 * The dedup key: a source-namespace prefix + the payload identity.
 *
 * The namespace does the real work. Settings hooks carry no root, so they
 * all share the '' prefix — one command written in user AND project AND
 * local settings still runs once, which is what dedup is FOR. An extension
 * or skill hook is prefixed by its root, so two extensions whose manifests
 * hold the same unexpanded `${MERCURY_EXTENSION_ROOT}/hook.sh` template stay
 * distinct — expanded, those templates name different files.
 */
export function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.extensionRoot ?? m.skillRoot ?? ''}\0${payload}`
}

/** Matched-hook counts keyed by hook transport type (command/prompt/…). */
export function getHookTypeCounts(hooks: MatchedHook[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const h of hooks) {
    counts[h.hook.type] = (counts[h.hook.type] || 0) + 1
  }
  return counts
}

/**
 * The three-source merge for one event, in precedence-free concatenation
 * order: settings snapshot, then registered hooks (SDK callbacks +
 * extension hooks), then this session's own derived and function hooks.
 * shouldAllowManagedHooksOnly() narrows the merge to managed sources —
 * extension matchers and everything session-scoped drop out.
 */
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
  // The snapshot's matchers already have the bare {matcher, hooks} shape
  // (zod stripped them at capture), so they seed the array as-is.
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
      // extensionRoot marks an extension matcher; SDK callbacks carry none.
      // Under managed-only policy the extension lane closes and callbacks stay.
      if (managedOnly && 'extensionRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  // Session hooks are scoped to the SESSION ID on purpose: a function hook
  // (structured-output enforcement, say) registered by one agent must never
  // fire in a sibling agent's turns. Managed-only policy skips the session
  // lane wholesale — frontmatter hooks from agents/skills would otherwise
  // ride around the policy. strictExtensionOnlyCustomization does NOT gate
  // here: it gates at the registration sites, where agentDefinition.source
  // is known — a blanket block at this seam would also kill extension
  // agents' frontmatter hooks. An absent appState skips the lane too (some
  // callers predate the store handle).
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionHooks) {
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    // Function hooks live in their own store slice — they hold live
    // closures, which the persistable HookMatcher shape cannot carry.
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

/**
 * "Might any hook fire for this event?" — the cheap pre-question hot paths
 * ask before paying for real matching. It walks the same three sources as
 * getHooksConfig() but stops at the first sign of life, and it rounds UP
 * on purpose: a matcher that managed-only policy or pattern filtering
 * would later drop still answers true. The asymmetry is the point — a
 * false yes costs one full matching pass; a false no would silently skip
 * a real hook. Callers use it to dodge createBaseHookInput's path joins
 * and getMatchingHooks entirely on the (typical) unconfigured event; the
 * instructions-loaded and worktree probes apply the same idea.
 */
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

/**
 * The field of the hook input that matcher patterns are matched against,
 * per event. undefined means the event has no match dimension (every
 * matcher fires) — and so does an EMPTY string value, which callers treat
 * the same way downstream.
 *
 * Coupled by contract to src/utils/hooks/hooksConfigManager.ts: the /hooks
 * config UI describes each event's matcher dimension to the operator, and
 * the two must tell the same story.
 */
function matchQueryForInput(hookInput: HookInput): string | undefined {
  switch (hookInput.hook_event_name) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied':
      return hookInput.tool_name
    case 'SessionStart':
    case 'ConfigChange':
      return hookInput.source
    case 'UserPromptExpansion':
      // The command being expanded (e.g. "debrief", "review").
      return hookInput.command_name
    case 'Setup':
    case 'PreCompact':
    case 'PostCompact':
      return hookInput.trigger
    case 'Notification':
      return hookInput.notification_type
    case 'SessionEnd':
      return hookInput.reason
    case 'StopFailure':
      return hookInput.error
    case 'SubagentStart':
    case 'SubagentStop':
      return hookInput.agent_type
    case 'Elicitation':
    case 'ElicitationResult':
      return hookInput.mcp_server_name
    case 'InstructionsLoaded':
      return hookInput.load_reason
    case 'FileChanged':
      return basename(hookInput.file_path)
    default:
      // TeammateIdle/TaskCreated/TaskCompleted and anything future-shaped:
      // no match dimension.
      return undefined
  }
}

/** The `if` condition of a hook, '' when absent — distinct conditions keep
 *  otherwise-identical hooks distinct in dedup keys. */
const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

/**
 * Dedup one transport type by payload identity, namespaced per hookDedupKey.
 * Map insertion keeps the LAST entry on key collision — for settings hooks
 * that means the last-merged scope wins; same-extension duplicates share an
 * extensionRoot, so order cannot matter there.
 */
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

/**
 * Resolve every hook that should run for this event input: merge the three
 * config sources, match on the event's query dimension, attach source
 * context, dedup within source namespaces, and apply `if` conditions.
 * Matching machinery failures degrade to "no hooks" — logged, never thrown
 * into the turn.
 */
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

    // Flatten matchers to hooks, carrying source context: extension and
    // skill matchers are recognized structurally (extensionRoot/skillRoot),
    // and hookSource names the origin for UI attribution.
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

    // Fast path: callback/function hooks are identity-unique (live closures)
    // and need no dedup. When ALL matched hooks are that kind — the common
    // case for internal hooks like sessionFileAccessHooks/attributionHooks —
    // skip the whole dedup+if machinery (44x faster in microbench).
    if (
      matchedHooks.every(
        m => m.hook.type === 'callback' || m.hook.type === 'function',
      )
    ) {
      return matchedHooks
    }

    // Dedup each spawnable transport by its payload identity (keys are
    // namespaced by extension/skill root via hookDedupKey, so cross-extension
    // template collisions don't drop hooks). For command
    // hooks the shell is part of identity: {command:'echo x', shell:'bash'}
    // and {command:'echo x', shell:'powershell'} are distinct hooks; the
    // default fills in so legacy configs (no shell field) still dedup
    // against an explicit shell:'bash'.
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

    // `if` conditions let a hook scope itself to matching tool input (e.g.
    // "Bash(git *)") so non-matching calls never pay the spawn. The matcher
    // is prepared once, only when some hook actually carries a condition.
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
        // FC-109: an `if` on a non-tool event has no tool input to evaluate
        // against — the hook is skipped (fail closed: running it would
        // ignore the operator's own narrowing), but the skip must be
        // NAMED, not a debug whisper: the config validated clean and the
        // hook simply never fired on any stream. Headless runs get one
        // stderr line; the hook-detail card names the dead gate too.
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

    // SessionStart/Setup cannot host HTTP hooks: in headless mode their
    // sandbox ask callback deadlocks — the structuredInput consumer has not
    // started when these events fire.
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
    // No-hooks is the safe degrade for a broken matcher pipeline, but the
    // break itself must not vanish (pre-rewrite this swallowed silently).
    logError(
      new Error('hook matching failed — running no hooks for this event', {
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    return []
  }
}

/** Hook definitions projected for telemetry — payload identity only, no source context. */
export function getHookDefinitionsForTelemetry(
  matchedHooks: MatchedHook[],
): Array<{ type: string; command?: string; prompt?: string; name?: string }> {
  return matchedHooks.map(({ hook }) => {
    if (hook.type === 'command') {
      return { type: 'command', command: hook.command }
    } else if (hook.type === 'prompt') {
      return { type: 'prompt', prompt: hook.prompt }
    } else if (hook.type === 'http') {
      return { type: 'http', command: hook.url }
    } else if (hook.type === 'function') {
      return { type: 'function', name: 'function' }
    } else if (hook.type === 'callback') {
      return { type: 'callback', name: 'callback' }
    }
    return { type: 'unknown' }
  })
}
