import { logForDebugging } from '../../utils/debug.js'
import {
  createCacheSafeParams,
  runForkedAgent,
  type CacheSafeParams,
} from '../agents/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../messages.js'
import type { TurnAnswerContext } from '../../query/turnAnswerContext.js'
import { currentLimits } from '../anthropicLimits.js'
import type { AppState } from '../../state/AppState.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'


export type PromptVariant = 'user_intent' | 'stated_intent'

const ACTIVE_VARIANT: PromptVariant = 'user_intent'


type SuppressReason =
  | 'disabled'
  | 'pending_permission'
  | 'elicitation_active'
  | 'rate_limit'
  | 'aborted'
  | 'early_conversation'
  | 'last_response_error'
  | 'cache_cold'
  | 'empty'

function getParentCacheSuppressReason(
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


const SUGGESTION_PROMPT = `Suggestion mode: propose the single line this user would most likely type next.

Rules:
- Predict from the user's recent messages and original request what they would write next — not the step you prefer.
- Prefer specific wording the user would recognise as what they were about to type.
- Reply with nothing if the next user step is unclear, or right after an error or misunderstanding.
- Never suggest evaluative remarks, questions, assistant-voice phrasing, unraised ideas, or multiple sentences.
- 2–12 words in the user's register, bare text only (no quotes or commentary), or nothing.

Examples:
- Failing test fixed, suite green -> commit and push
- Helper rename has two call sites left -> finish the remaining call sites
- Unexpected build error just reported -> (reply with nothing)
- Config flag explained -> enable it in staging
- "run the linter" finished clean -> looks done, ship it`


const ALLOWED_SINGLE_WORDS: Set<string> = new Set([
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
  | 'assistant_voice'
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
  if (ASSISTANT_VOICE_OPENERS.some(opener => lowered.startsWith(opener))) return 'assistant_voice'
  return undefined
}

function shouldFilterSuggestion(suggestion: string): boolean {
  const reason = filterReasonFor(suggestion)
  if (reason === undefined) return false
  logSuggestionSuppressed(reason)
  return true
}

let inFlightController: AbortController | null = null

function getStateSuppressReason(appState: AppState): SuppressReason | undefined {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest) return 'pending_permission'
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  if (currentLimits.status !== 'allowed') return 'rate_limit'
  return undefined
}

function getPreGenerationSuppressReason(
  messages: Message[],
  appState: AppState,
  aborted: boolean,
): SuppressReason | undefined {
  if (aborted) return 'aborted'
  const assistants: AssistantMessage[] = []
  for (const message of messages) {
    if (message.type === 'assistant') assistants.push(message)
  }
  if (assistants.length < 2) return 'early_conversation'
  const lastAssistant = assistants[assistants.length - 1]
  if (lastAssistant.isApiErrorMessage === true) return 'last_response_error'
  const cacheReason = getParentCacheSuppressReason(lastAssistant)
  if (cacheReason !== undefined) return cacheReason
  return getStateSuppressReason(appState)
}

function extractSuggestionText(
  content: string | readonly { type: string; text?: unknown }[],
): string {
  if (typeof content === 'string') return content.trim()
  let joined = ''
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      joined += block.text
    }
  }
  return joined.trim()
}

async function generateSuggestion(
  cacheSafeParams: CacheSafeParams,
  abortController: AbortController,
  _variant: PromptVariant,
): Promise<{ suggestion: string | undefined; requestId?: string }> {
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: SUGGESTION_PROMPT, isMeta: true })],
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'tools are unavailable while generating a suggestion',
      decisionReason: {
        type: 'other',
        reason: 'tools are unavailable while generating a suggestion',
      },
    }),
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: { abortController },
    skipTranscript: true,
    skipCacheWrite: true,
  })

  let requestId: string | undefined
  for (const message of result.messages) {
    if (message.type !== 'assistant') continue
    if (requestId === undefined && typeof message.requestId === 'string') {
      requestId = message.requestId
    }
    const text = extractSuggestionText(message.message.content)
    if (text.length > 0) {
      return requestId !== undefined ? { suggestion: text, requestId } : { suggestion: text }
    }
  }
  return requestId !== undefined ? { suggestion: undefined, requestId } : { suggestion: undefined }
}

export async function executePromptSuggestion(context: TurnAnswerContext): Promise<void> {
  if (!context.querySource?.startsWith('main_thread')) return

  const controller = new AbortController()
  inFlightController?.abort()
  inFlightController = controller

  try {
    const appState = context.toolUseContext.getAppState()
    const aborted =
      controller.signal.aborted || context.toolUseContext.abortController.signal.aborted
    const preSuppress = getPreGenerationSuppressReason(context.messages, appState, aborted)
    if (preSuppress !== undefined) {
      logSuggestionSuppressed(preSuppress)
      return
    }

    const cacheSafeParams = createCacheSafeParams(context)
    const generated = await generateSuggestion(cacheSafeParams, controller, ACTIVE_VARIANT)

    if (controller.signal.aborted || context.toolUseContext.abortController.signal.aborted) {
      logSuggestionSuppressed('aborted')
      return
    }

    if (!generated.suggestion) {
      logSuggestionSuppressed('empty')
      return
    }

    if (shouldFilterSuggestion(generated.suggestion)) {
      return
    }

    const result = {
      suggestion: generated.suggestion,
      promptId: ACTIVE_VARIANT,
      generationRequestId: generated.requestId ?? null,
    }
    const setAppState = context.toolUseContext.setAppState
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
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
      logSuggestionSuppressed('aborted')
    } else {
      logError(error)
    }
  } finally {
    if (inFlightController === controller) {
      inFlightController = null
    }
  }
}

function logSuggestionSuppressed(reason: string): void {
  logForDebugging(`prompt suggestion suppressed: ${reason}`)
}
