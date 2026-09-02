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


export function parseTokenCount(input: string): number | 'auto' | undefined {
  const s = input.trim().toLowerCase()
  if (s === '') return undefined
  if (s === 'auto') return 'auto'

  const suffixed = s.match(/^(\d+(?:\.\d+)?)\s*([km])$/)
  if (suffixed) {
    const n = parseFloat(suffixed[1]!)
    if (isNaN(n)) return undefined
    return Math.round(n * (suffixed[2] === 'm' ? 1_000_000 : 1_000))
  }

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    if (isNaN(n) || n <= 0) return undefined
    return n < 1000 ? n * 1_000 : n
  }

  return undefined
}


function buildAutoCompactStatus(
  model: string,
  settingsValue: number | undefined,
): string {
  const { window, configured, source } = resolveAutoCompactWindow(
    model,
    settingsValue,
  )

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


export function applyAutoCompactWindow(arg: string, model: string): string {
  const normalized = arg.trim().toLowerCase()
  const parsed = ['reset', 'unset', 'default'].includes(normalized)
    ? 'auto'
    : parseTokenCount(normalized)
  if (parsed === undefined) {
    return `Couldn't parse '${arg}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`
  }

  const clamped =
    parsed === 'auto'
      ? ('auto' as const)
      : Math.min(MAX_AUTOCOMPACT_WINDOW, Math.max(MIN_AUTOCOMPACT_WINDOW, parsed))
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
