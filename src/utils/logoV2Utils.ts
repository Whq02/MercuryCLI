import { getDirectConnectServerUrl, getSessionId } from '../bootstrap/state.js'
import { MERCURY_VERSION } from '../constants/product.js'
import type { SessionListing } from '../types/logs.js'
import { getSubscriptionName, isClaudeAISubscriber } from './auth.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { resolveOpenaiAccount } from '../services/providers/openai/openaiAccounts.js'
import { getEngineModel } from './model/model.js'
import { getCwd } from './cwd.js'
import { getDisplayPath } from './file.js'
import { listProjectSessions } from './sessionStorage.js'
import { getInitialSettings } from './settings/settings.js'

const RECENT_ACTIVITY_LOAD_LIMIT = 10
const RECENT_ACTIVITY_KEEP = 3
const NO_PROMPT_PLACEHOLDER = 'No prompt'
const APOLOGY_MARKER = 'I apologize'

let recentActivityPromise: Promise<SessionListing[]> | null = null

function meaningful(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== NO_PROMPT_PLACEHOLDER
}

export function getRecentActivity(): Promise<SessionListing[]> {
  if (recentActivityPromise) return recentActivityPromise
  recentActivityPromise = (async () => {
    try {
      const logs = await listProjectSessions(RECENT_ACTIVITY_LOAD_LIMIT)
      const currentSession = getSessionId()
      const kept = logs
        .filter(log => !log.isSidechain)
        .filter(log => log.sessionId !== currentSession)
        .filter(log => !(log.summary ?? '').includes(APOLOGY_MARKER))
        .filter(log => meaningful(log.summary) || meaningful(log.firstPrompt))
        .slice(0, RECENT_ACTIVITY_KEEP)
      return kept
    } catch {
      return []
    }
  })()
  return recentActivityPromise
}


const DEMO_PLACEHOLDER_PATH = '/code/mercury'

export function getLogoDisplayData(): { version: string; cwd: string; billingType: string; agentName?: string } {
  const version = process.env.MERCURY_DEMO_VERSION ?? MERCURY_VERSION
  let cwd = process.env.MERCURY_DEMO_VERSION ? DEMO_PLACEHOLDER_PATH : getDisplayPath(getCwd())
  const directConnect = getDirectConnectServerUrl()
  if (directConnect) {
    cwd = `${cwd} in ${directConnect.replace(/^https?:\/\//, '')}`
  }
  const billingType = ((): string => {
    try {
      const route = declaredRouteOf(getEngineModel())
      if (route === 'openai') return resolveOpenaiAccount()?.label ?? 'OpenAI account'
      if (route === 'zai') return 'Z.AI API usage billing'
      if (route === 'moonshot') return 'Moonshot API usage billing'
      if (route === 'deepseek') return 'DeepSeek API usage billing'
      if (route === 'xai') return 'xAI API usage billing'
      if (route === 'openai-compat') return 'Custom endpoint billing'
      if (route === 'openrouter') return 'OpenRouter billing (folds from the auth lane)'
      if (route === 'gemini') return 'Gemini billing (folds from the auth lane)'
      if (route === 'huggingface') return 'Hugging Face credits / pay-as-you-go billing'
      if (route === 'local') return 'local model · no metering'
      if (route === null) return 'unrecognised model · no billed lane'
    } catch {
    }
    return isClaudeAISubscriber() ? getSubscriptionName() : 'API usage billing'
  })()
  const agentName = getInitialSettings().engine?.agent
  return { version, cwd, billingType, ...(agentName ? { agentName } : {}) }
}
