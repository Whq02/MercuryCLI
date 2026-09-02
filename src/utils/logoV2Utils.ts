import { sep } from 'node:path'

import { getDirectConnectServerUrl, getSessionId } from '../bootstrap/state.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { LogOption } from '../types/logs.js'
import { getSubscriptionName, isClaudeAISubscriber } from './auth.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { resolveOpenaiAccount } from '../services/providers/openai/openaiAccounts.js'
import { getMainLoopModel } from './model/model.js'
import { getCwd } from './cwd.js'
import { getDisplayPath } from './file.js'
import { truncateToWidth, truncateToWidthNoEllipsis } from './format.js'
import { getStoredChangelogFromMemory, parseChangelog } from './releaseNotes.js'
import { loadMessageLogs } from './sessionStorage.js'
import { getInitialSettings } from './settings/settings.js'

import { gt } from 'semver'

/**
 * Pure layout maths and data assembly for the home/splash logo panel; the
 * rendering component lives elsewhere.
 */

export type LayoutMode = 'horizontal' | 'compact'
export type LayoutDimensions = { leftWidth: number; rightWidth: number; totalWidth: number }

const MAX_LEFT_WIDTH = 50
const MAX_USERNAME_LENGTH = 20
const BORDER_PADDING = 4
const DIVIDER_WIDTH = 1
const CONTENT_PADDING = 2
const MIN_RIGHT_WIDTH = 30
const MASCOT_FLOOR = 20
const ELLIPSIS = '…'

export function getLayoutMode(columns: number): LayoutMode {
  return columns >= 70 ? 'horizontal' : 'compact'
}

export function calculateLayoutDimensions(columns: number, layoutMode: LayoutMode, optimalLeftWidth: number): LayoutDimensions {
  if (layoutMode === 'compact') {
    const total = Math.min(columns - BORDER_PADDING, MAX_LEFT_WIDTH + 20)
    return { leftWidth: total, rightWidth: total, totalWidth: total }
  }
  const leftWidth = optimalLeftWidth
  const used = BORDER_PADDING + CONTENT_PADDING + DIVIDER_WIDTH + leftWidth
  let rightWidth = Math.max(columns - used, MIN_RIGHT_WIDTH)
  let totalWidth = leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING
  const cap = columns - BORDER_PADDING
  if (totalWidth > cap) {
    totalWidth = cap
    rightWidth = totalWidth - leftWidth - DIVIDER_WIDTH - CONTENT_PADDING
  }
  return { leftWidth, rightWidth, totalWidth }
}

/** Display-width measurement throughout, so double-width and combining characters measure correctly. */
export function calculateOptimalLeftWidth(welcomeMessage: string, truncatedCwd: string, modelLine: string): number {
  const widest = Math.max(stringWidth(welcomeMessage), stringWidth(truncatedCwd), stringWidth(modelLine), MASCOT_FLOOR)
  return Math.min(widest + 4, MAX_LEFT_WIDTH)
}

/** Mercury-original brand copy — the splash keeps its voice. */
export function formatWelcomeMessage(username: string | null): string {
  if (username && username.length <= MAX_USERNAME_LENGTH) return `At the helm, ${username}!`
  return 'Fair winds!'
}

// ---------------------------------------------------------------------------
// Middle-truncating a path
// ---------------------------------------------------------------------------

export function truncatePath(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path
  const parts = path.split(sep)
  if (parts.length === 1) return truncateToWidth(path, maxLength)
  const first = parts[0] as string
  const last = parts[parts.length - 1] as string
  const lastWidth = stringWidth(last)
  if (first === '') {
    // An absolute POSIX path: no first component to elide.
    if (1 + 1 + lastWidth >= maxLength) {
      return `${sep}${truncateToWidth(last, Math.max(maxLength - 1, 1))}`
    }
  } else if (stringWidth(first) + 1 + 1 + lastWidth >= maxLength) {
    return `${ELLIPSIS}${sep}${truncateToWidth(last, Math.max(maxLength - 2, 1))}`
  }
  if (parts.length === 2) {
    const room = maxLength - (1 + 1 + lastWidth)
    return `${truncateToWidthNoEllipsis(first, room)}${ELLIPSIS}${sep}${last}`
  }
  const firstWidth = stringWidth(first)
  const middleRoom = maxLength - firstWidth - lastWidth - 1 - 2
  if (middleRoom <= 0) {
    const room = maxLength - (lastWidth + 1 + 2)
    return `${truncateToWidthNoEllipsis(first, room)}${sep}${ELLIPSIS}${sep}${last}`
  }
  // Greedily take middle components from the right inwards.
  const middles = parts.slice(1, -1)
  const kept: string[] = []
  let remaining = middleRoom
  for (let index = middles.length - 1; index >= 0; index--) {
    const cost = stringWidth(middles[index] as string) + 1
    if (cost > remaining) break
    kept.unshift(middles[index] as string)
    remaining -= cost
  }
  if (kept.length === 0) return `${first}${sep}${ELLIPSIS}${sep}${last}`
  return `${first}${sep}${ELLIPSIS}${sep}${kept.join(sep)}${sep}${last}`
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

const RECENT_ACTIVITY_LOAD_LIMIT = 10
const RECENT_ACTIVITY_KEEP = 3
/** The sentinel the session-storage first-prompt extractor writes. */
const NO_PROMPT_PLACEHOLDER = 'No prompt'
const APOLOGY_MARKER = 'I apologize'

let recentActivityPromise: Promise<LogOption[]> | null = null
let recentActivityResolved: LogOption[] = []

function meaningful(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== NO_PROMPT_PLACEHOLDER
}

/** Single-flight and never cleared: recent activity loads at most once per process. */
export function getRecentActivity(): Promise<LogOption[]> {
  if (recentActivityPromise) return recentActivityPromise
  recentActivityPromise = (async () => {
    try {
      const logs = await loadMessageLogs(RECENT_ACTIVITY_LOAD_LIMIT)
      const currentSession = getSessionId()
      const kept = logs
        .filter(log => !log.isSidechain)
        .filter(log => log.sessionId !== currentSession)
        .filter(log => !(log.summary ?? '').includes(APOLOGY_MARKER))
        .filter(log => meaningful(log.summary) || meaningful(log.firstPrompt))
        .slice(0, RECENT_ACTIVITY_KEEP)
      recentActivityResolved = kept
      return kept
    } catch {
      recentActivityResolved = []
      return []
    }
  })()
  return recentActivityPromise
}

/** Empty until the loader completes; render paths must tolerate that. */
export function getRecentActivitySync(): LogOption[] {
  return recentActivityResolved
}

// ---------------------------------------------------------------------------
// Display data and the model/billing line
// ---------------------------------------------------------------------------

const DEMO_PLACEHOLDER_PATH = '/code/claude'

export function getLogoDisplayData(): { version: string; cwd: string; billingType: string; agentName?: string } {
  const version = process.env.DEMO_VERSION ?? MERCURY_VERSION
  let cwd = process.env.DEMO_VERSION ? DEMO_PLACEHOLDER_PATH : getDisplayPath(getCwd())
  const directConnect = getDirectConnectServerUrl()
  if (directConnect) {
    cwd = `${cwd} in ${directConnect.replace(/^https?:\/\//, '')}`
  }
  // The billing identity reflects the ACTIVE lane (provider parity): an
  // OpenAI-primary boot names the OpenAI account source, not Anthropic state.
  const billingType = ((): string => {
    try {
      const route = declaredRouteOf(getMainLoopModel())
      if (route === 'openai') return resolveOpenaiAccount()?.label ?? 'OpenAI account'
      if (route === 'zai') return 'Z.AI API usage billing'
      if (route === 'moonshot') return 'Moonshot API usage billing'
      if (route === 'deepseek') return 'DeepSeek API usage billing'
      if (route === 'openai-compat') return 'Custom endpoint billing'
      if (route === 'openrouter') return 'OpenRouter billing (folds from the auth lane)'
      if (route === 'gemini') return 'Gemini billing (folds from the auth lane)'
      if (route === 'huggingface') return 'Hugging Face credits / pay-as-you-go billing'
      if (route === 'local') return 'local model · no metering'
      // No family declares the session model: no billed lane exists to
      // name — never the Anthropic identity by remainder.
      if (route === null) return 'unrecognised model · no billed lane'
    } catch {
      /* early-boot read trouble ⇒ the Anthropic identity below */
    }
    return isClaudeAISubscriber() ? getSubscriptionName() : 'API usage billing'
  })()
  const agentName = (getInitialSettings() as { agent?: string }).agent
  return { version, cwd, billingType, ...(agentName ? { agentName } : {}) }
}

const MODEL_BILLING_SEPARATOR_WIDTH = 3
const MODEL_MIN_WIDTH = 10

export function formatModelAndBilling(
  modelName: string,
  billingType: string,
  availableWidth: number,
): { shouldSplit: boolean; truncatedModel: string; truncatedBilling: string } {
  const combined = stringWidth(modelName) + MODEL_BILLING_SEPARATOR_WIDTH + stringWidth(billingType)
  if (combined > availableWidth) {
    return {
      shouldSplit: true,
      truncatedModel: truncateToWidth(modelName, availableWidth),
      truncatedBilling: truncateToWidth(billingType, availableWidth),
    }
  }
  const modelRoom = Math.max(availableWidth - stringWidth(billingType) - MODEL_BILLING_SEPARATOR_WIDTH, MODEL_MIN_WIDTH)
  return { shouldSplit: false, truncatedModel: truncateToWidth(modelName, modelRoom), truncatedBilling: billingType }
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

/** The three highest versions' notes, raw, in version order, capped at the requested count. */
export function getRecentReleaseNotesSync(maxItems: number): string[] {
  const stored = getStoredChangelogFromMemory()
  if (!stored) return []
  let parsed: Record<string, string[]>
  try {
    parsed = parseChangelog(stored)
  } catch {
    return []
  }
  const versions = Object.keys(parsed).sort((a, b) => (gt(a, b) ? -1 : 1))
  const notes: string[] = []
  for (const version of versions.slice(0, 3)) {
    notes.push(...(parsed[version] ?? []))
  }
  return notes.slice(0, maxItems)
}
