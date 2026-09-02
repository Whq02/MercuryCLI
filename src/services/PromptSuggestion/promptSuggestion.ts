import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createCacheSafeParams,
  runForkedAgent,
  type CacheSafeParams,
  type ForkedAgentParams,
} from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isTeammate } from '../../utils/teammate.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { currentLimits } from '../claudeAiLimits.js'
import type { AppState } from '../../state/AppState.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'


export type PromptVariant = 'user_intent' | 'stated_intent'

const ACTIVE_VARIANT: PromptVariant = 'user_intent'


export function shouldEnablePromptSuggestion(): boolean {
  if (getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_chomp_inflection', false) !== true) {
    return false
  }
  if (getIsNonInteractiveSession()) return false
  if (isAgentSwarmsEnabled() && isTeammate()) return false
  return getInitialSettings()?.promptSuggestionEnabled !== false
}


type SuppressReason =
  | 'disabled'
  | 'pending_permission'
  | 'elicitation_active'
  | 'plan_mode'
  | 'rate_limit'
  | 'aborted'
  | 'early_conversation'
  | 'last_response_error'
  | 'cache_cold'
  | 'empty'

export function getSuggestionSuppressReason(appState: AppState): SuppressReason | undefined {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest) {
    return 'pending_permission'
  }
  if ((appState.elicitation?.queue?.length ?? 0) > 0) return 'elicitation_active'
  if (appState.toolPermissionContext.mode === 'strategy') return 'plan_mode'
  if (currentLimits.status !== 'allowed') return 'rate_limit'
  return undefined
}

export function getParentCacheSuppressReason(
  lastAssistantMessage: {
    message?: {
      usage?: {
        input_tokens?: number
        cache_creation_input_tokens?: number | null
        output_tokens?: number
      }
    }
  } | undefined,
): SuppressReason | undefined {
  const usage = lastAssistantMessage?.message?.usage
  if (usage === undefined) return undefined
  const total =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
  if (total > 10_000) return 'cache_cold'
  return undefined
}


const SUGGESTION_PROMPT = `You are in suggestion mode: propose the single line this user would most likely type next in this conversation.

Rules:
- Work only from the user's own recent messages and their original request. Suggest what THEY would write next, not the step you think is best.
- A good candidate is one the user would recognise as the thing they were already about to type.
- Prefer specific wording over generic wording.
- If the user's own words do not make the next step evident, reply with nothing at all. Likewise reply with nothing right after an error or a misunderstanding — the user should get to assess or correct first.
- Never suggest: evaluative remarks, questions, assistant-voice phrasing, new ideas the user did not raise, or more than one sentence.
- Length and form: between two and twelve words, in the user's own register, or nothing. Reply with the bare suggestion — no quotation marks, no commentary.

Examples:
- The user asked you to fix a failing test; you fixed it and the suite is green. -> commit and push
- The user asked to rename a helper across the repo; two call sites remain. -> finish the remaining call sites
- You just reported an unexpected build error. -> (reply with nothing)
- The user asked what a config flag does; you explained it. -> enable it in staging
- The user said "run the linter" and it finished clean. -> looks done, ship it`


export async function generateSuggestion(
  abortController: AbortController,
  promptId: PromptVariant,
  cacheSafeParams: CacheSafeParams,
): Promise<{ suggestion: string; requestId?: string } | undefined> {
  void promptId
  const instruction = createUserMessage({ content: SUGGESTION_PROMPT, isMeta: true })
  const result = await runForkedAgent({
    promptMessages: [instruction],
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'tools are unavailable while generating a suggestion',
    }),
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: { abortController },
    skipTranscript: true,
    suppressCacheWrites: true,
  } as unknown as ForkedAgentParams)
  const messages = (result as { messages?: unknown[] }).messages ?? []
  let requestId: string | undefined
  let suggestion: string | undefined
  for (const raw of messages) {
    const message = raw as {
      type?: string
      requestId?: string
      message?: { content?: unknown }
    }
    if (message.type !== 'assistant') continue
    if (requestId === undefined && typeof message.requestId === 'string') {
      requestId = message.requestId
    }
    const content = message.message?.content
    if (typeof content === 'string') {
      if (content.trim() !== '') {
        suggestion = content.trim()
        break
      }
      continue
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        .map(block => block.text)
        .join('')
        .trim()
      if (text !== '') {
        suggestion = text
        break
      }
    }
  }
  if (suggestion === undefined) return undefined
  return { suggestion, ...(requestId === undefined ? {} : { requestId }) }
}


const ALLOWED_SINGLE_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'yea',
  'yup',
  'sure',
  'ok',
  'okay',
  'push',
  'commit',
  'deploy',
  'stop',
  'continue',
  'check',
  'exit',
  'quit',
  'no',
])

const EVALUATIVE_TOKENS = [
  'thanks',
  'thank you',
  'looks good',
  'sounds good',
  'that works',
  'that worked',
  "that's all",
  'nice',
  'great',
  'perfect',
  'makes sense',
  'awesome',
  'excellent',
]

const ASSISTANT_VOICE_OPENERS = [
  'let me',
  "i'll",
  "i've",
  "i'm",
  'i can',
  'i would',
  'i think',
  'i notice',
  "here's",
  'here is',
  'here are',
  "that's",
  'this is',
  'this will',
  'you can',
  'you should',
  'you could',
  'sure,',
  'of course',
  'certainly',
]

const ERROR_PREFIXES = [
  'api error:',
  'prompt is too long',
  'request timed out',
  'invalid api key',
  'image was too large',
]

type FilterReason =
  | 'done'
  | 'meta_text'
  | 'meta_wrapped'
  | 'error_message'
  | 'prefixed_label'
  | 'too_few_words'
  | 'too_many_words'
  | 'too_long'
  | 'multiple_sentences'
  | 'has_formatting'
  | 'evaluative'
  | 'claude_voice'
  | 'empty'

function filterReasonFor(suggestion: string): FilterReason | undefined {
  const trimmed = suggestion.trim()
  if (trimmed === '') return 'empty'
  const lowered = trimmed.toLowerCase()
  const words = trimmed.split(/\s+/)

  if (lowered === 'done') return 'done'
  if (
    lowered === 'nothing found' ||
    lowered === 'nothing found.' ||
    lowered.startsWith('nothing to suggest') ||
    lowered.startsWith('no suggestion') ||
    lowered.includes('silence is') ||
    /stay(s|ing)? silent/.test(lowered) ||
    /^[^a-z0-9]*silence[^a-z0-9]*$/.test(lowered)
  ) {
    return 'meta_text'
  }
  if (/^\(.*\)$/s.test(trimmed) || /^\[.*\]$/s.test(trimmed)) return 'meta_wrapped'
  if (ERROR_PREFIXES.some(prefix => lowered.startsWith(prefix))) return 'error_message'
  if (/^\w+: /.test(trimmed)) return 'prefixed_label'
  if (words.length < 2 && !trimmed.startsWith('/') && !ALLOWED_SINGLE_WORDS.has(lowered)) {
    return 'too_few_words'
  }
  if (words.length > 12) return 'too_many_words'
  if (trimmed.length >= 100) return 'too_long'
  if (/[.!?]\s+[A-Z]/.test(trimmed)) return 'multiple_sentences'
  if (trimmed.includes('\n') || trimmed.includes('*')) return 'has_formatting'
  if (EVALUATIVE_TOKENS.some(token => lowered.includes(token))) return 'evaluative'
  if (ASSISTANT_VOICE_OPENERS.some(opener => lowered.startsWith(opener))) return 'claude_voice'
  return undefined
}

export function shouldFilterSuggestion(
  suggestion: string,
  promptId?: string | null,
  source?: string,
  generationRequestId?: string | null,
): boolean {
  const reason = filterReasonFor(suggestion)
  if (reason === undefined) return false
  logSuggestionSuppressed(reason, promptId ?? undefined, source, generationRequestId)
  return true
}


export async function tryGenerateSuggestion(
  abortController: AbortController,
  messages: unknown[],
  getAppState: () => AppState,
  cacheSafeParams: CacheSafeParams,
  source?: string,
): Promise<
  { suggestion: string; promptId: PromptVariant; generationRequestId: string | null } | undefined
> {
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, source)
    return undefined
  }
  const assistantMessages = messages.filter(
    message => (message as { type?: string }).type === 'assistant',
  )
  if (assistantMessages.length < 2) {
    logSuggestionSuppressed('early_conversation', undefined, source)
    return undefined
  }
  const lastAssistant = assistantMessages[assistantMessages.length - 1] as {
    isApiErrorMessage?: boolean
  }
  if (lastAssistant.isApiErrorMessage === true) {
    logSuggestionSuppressed('last_response_error', undefined, source)
    return undefined
  }
  const cacheReason = getParentCacheSuppressReason(lastAssistant as never)
  if (cacheReason !== undefined) {
    logSuggestionSuppressed(cacheReason, undefined, source)
    return undefined
  }
  const stateReason = getSuggestionSuppressReason(getAppState())
  if (stateReason !== undefined) {
    logSuggestionSuppressed(stateReason, undefined, source)
    return undefined
  }

  const generated = await generateSuggestion(abortController, ACTIVE_VARIANT, cacheSafeParams)
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, source)
    return undefined
  }
  if (generated === undefined || generated.suggestion === '') {
    logSuggestionSuppressed('empty', undefined, source)
    return undefined
  }
  if (shouldFilterSuggestion(generated.suggestion, ACTIVE_VARIANT, source)) {
    return undefined
  }
  return {
    suggestion: generated.suggestion,
    promptId: ACTIVE_VARIANT,
    generationRequestId: generated.requestId ?? null,
  }
}


let inFlightController: AbortController | null = null

function isAbortShapedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  )
}

export function abortPromptSuggestion(): void {
  inFlightController?.abort()
  inFlightController = null
}

export async function executePromptSuggestion(context: REPLHookContext): Promise<void> {
  if (context.querySource === undefined || !context.querySource.startsWith('repl_main_thread')) {
    return
  }
  const { getAppState, setAppState } = context.toolUseContext
  const controller = new AbortController()
  inFlightController?.abort()
  inFlightController = controller
  try {
    const cacheSafeParams = createCacheSafeParams(context)
    const result = await tryGenerateSuggestion(
      controller,
      context.messages,
      getAppState,
      cacheSafeParams,
    )
    if (result === undefined) return
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: result.suggestion,
        promptId: result.promptId,
        generationRequestId: result.generationRequestId,
        shownAt: 0,
        acceptedAt: 0,
      },
    }))
    if (isSpeculationEnabled()) {
      void startSpeculation(result.suggestion, context, setAppState, false, cacheSafeParams)
    }
  } catch (error) {
    if (isAbortShapedError(error)) {
      logSuggestionSuppressed('aborted')
      return
    }
    logError(error)
  } finally {
    if (inFlightController === controller) {
      inFlightController = null
    }
  }
}


export function logSuggestionSuppressed(
  reason: string,
  promptId?: string | null,
  source?: string,
  generationRequestId?: string | null,
): void {
  const resolvedVariant = promptId ?? ACTIVE_VARIANT
  void resolvedVariant
  void source
  void generationRequestId
  logForDebugging(`prompt suggestion suppressed: ${reason}`)
}

export function logSuggestionOutcome(
  input: string,
  suggestion: string,
  shownAt: number,
  promptId?: string | null,
  requestId?: string | null,
): void {
  const accepted = input === suggestion
  const similarity =
    suggestion.length === 0 ? 0 : Math.round((input.length / suggestion.length) * 100) / 100
  const elapsedMs = Math.max(0, Date.now() - shownAt)
  void accepted
  void similarity
  void elapsedMs
  void (promptId ?? ACTIVE_VARIANT)
  void requestId
}
