import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'
import {
  MAX_AUTOCOMPACT_WINDOW,
  MIN_AUTOCOMPACT_WINDOW,
  isAutoCompactEnabled,
  resolveAutoCompactWindow,
} from '../../services/compact/autoCompact.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { formatTokens } from '../../utils/format.js'

// ============================================================================
// /auto-compact-window — inspect or change the auto-compact window.
// ----------------------------------------------------------------------------
// Bare invocation answers with a status block: the window in force, which
// layer supplied it, whether the model shrank a larger configured value, and
// an off notice when auto-compact is disabled. Given an argument, the
// command turns it into either a token count or the auto keyword family
// (auto / reset / unset / default), bounds numbers to 100k–1M, and writes
// settings.autoCompactWindow.
//
// Layering: the setting beats the model default, and resolution caps
// everything at the model's true context ceiling. A write here is
// immediately effective because resolveAutoCompactWindow
// (services/compact/autoCompact.ts) reads the global config fresh each
// turn. (The setting is the only control — no env rung.)
// ============================================================================

/**
 * Turn user input into a token count. Accepted spellings: a k/m suffix
 * ("500k", "1m"), a plain integer ("200000"), or the small-number shorthand
 * where anything under 1000 means thousands ("200" ⇒ 200_000). The word
 * "auto" comes back as its own sentinel; anything else comes back undefined.
 */
export function parseTokenCount(input: string): number | 'auto' | undefined {
  const s = input.trim().toLowerCase()
  if (s === '') return undefined
  if (s === 'auto') return 'auto'

  // "500k" / "1m" suffix forms.
  const suffixed = s.match(/^(\d+(?:\.\d+)?)\s*([km])$/)
  if (suffixed) {
    const n = parseFloat(suffixed[1]!)
    if (isNaN(n)) return undefined
    return Math.round(n * (suffixed[2] === 'm' ? 1_000_000 : 1_000))
  }

  // Bare integer.
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    if (isNaN(n) || n <= 0) return undefined
    return n < 1000 ? n * 1_000 : n
  }

  return undefined
}

// --- status report (no argument) --------------------------------------------

/**
 * The multi-line status shown by a bare `/auto-compact-window`: resolved
 * window + source, a model-cap note when the configured value exceeds what
 * the model allows, an off notice when auto-compact is disabled, and the
 * standing explanation. Manual overrides (env or settings) earn an extra
 * cost caution.
 */
function buildAutoCompactStatus(
  model: string,
  settingsValue: number | undefined,
): string {
  const { window, configured, source } = resolveAutoCompactWindow(
    model,
    settingsValue,
  )

  // The model-cap note belongs only to the two manual sources below —
  // auto/experiment labels never carry it.
  const cappedSuffix =
    configured > window ? ` · capped to ${formatTokens(window)} by model` : ''
  let sourceLabel: string
  switch (source) {
    case 'auto':
    case 'model-default':
      sourceLabel = 'auto'
      break
    case 'experiment':
      sourceLabel = `auto (${formatTokens(configured)} tokens)`
      break
    default:
      sourceLabel = `${formatTokens(configured)} tokens (from settings)${cappedSuffix}`
  }

  const lines: string[] = [`Auto-compact window: ${sourceLabel}`]
  if (!isAutoCompactEnabled()) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    "When context usage nears this limit, auto-compact condenses the conversation so the session can keep going. The effective threshold is whichever is lower: this window or the model's maximum context window.",
    'The auto setting picks a window tuned to the model — the recommended choice for cost and performance.',
  )
  if (source === 'settings') {
    lines.push(
      'A manual override can cost significantly more tokens, especially when resuming long sessions.',
    )
  }
  return lines.join('\n')
}

// --- apply (with argument) ---------------------------------------------------

/**
 * The write path: parse, bound, persist, confirm. Returns the line shown to
 * the user. Notable turns in the flow — reset/unset/default all mean 'auto',
 * which persists as an ABSENT setting; a failed parse names the accepted
 * forms; and after saving,
 * the value is resolved again so the confirmation can admit when some
 * higher layer (or the model's ceiling) still controls the outcome.
 */
export function applyAutoCompactWindow(arg: string, model: string): string {
  const normalized = arg.trim().toLowerCase()
  const parsed = ['reset', 'unset', 'default'].includes(normalized)
    ? 'auto'
    : parseTokenCount(normalized)
  if (parsed === undefined) {
    return `Couldn't parse '${arg}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`
  }

  // Numbers land inside the shared bounds here; the resolver applies the
  // model's own ceiling separately at read time.
  const clamped =
    parsed === 'auto'
      ? ('auto' as const)
      : Math.min(MAX_AUTOCOMPACT_WINDOW, Math.max(MIN_AUTOCOMPACT_WINDOW, parsed))
  // 'auto' persists as an ABSENT setting — cleared, not stored.
  const valueToPersist = clamped === 'auto' ? undefined : clamped

  try {
    saveGlobalConfig(prev =>
      prev.autoCompactWindow === valueToPersist
        ? prev
        : { ...prev, autoCompactWindow: valueToPersist },
    )
  } catch (e) {
    return `Couldn't save setting: ${e instanceof Error ? e.message : String(e)}`
  }

  // Re-resolve against live settings: a higher-priority source may still be
  // in charge, and the confirmation must say so.
  const liveSettingsValue = getGlobalConfig().autoCompactWindow
  const effective = resolveAutoCompactWindow(model, liveSettingsValue)
  const overrideActive = liveSettingsValue !== valueToPersist
  const overrideNote = `a higher-priority override is active (${formatTokens(effective.window)} tokens)`

  if (clamped === 'auto') {
    return overrideActive
      ? `Auto-compact window set to auto in settings, but ${overrideNote}`
      : 'Auto-compact window set to auto'
  }
  const suffix = overrideActive
    ? `, but ${overrideNote}`
    : effective.window < clamped
      ? ` (capped to model limit of ${formatTokens(effective.window)})`
      : ''
  return `Auto-compact window set to ${formatTokens(clamped)} tokens${suffix}`
}

// --- command entry ------------------------------------------------------------

/** The `/auto-compact-window` body: bare → status, argument → apply. */
export const call = async (
  arg: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const model = context.options.mainLoopModel
  const trimmed = arg.trim()
  const value = trimmed
    ? applyAutoCompactWindow(trimmed, model)
    : buildAutoCompactStatus(model, getGlobalConfig().autoCompactWindow)
  return { type: 'text', value }
}
