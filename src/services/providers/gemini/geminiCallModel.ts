import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import {
  compatChatCallModel,
  compatLaneLiveProofState,
  type CompatLaneProfile,
} from '../openaicompat/compatChatCallModel.js'
import { buildGeminiExtras } from '../openaicompat/compatWire.js'
import { randomUUID } from 'node:crypto'
import { geminiApiBase, resolveGeminiAccount, resolveGeminiRequestAuth } from './geminiAccounts.js'
import { configuredProviderKeyCommand, providerKeyCommandFailure, recoverProviderKeyCommand } from '../providerKeyCommand.js'
import { geminiEffortVocabularyFor, geminiOutputTokenLimitFor, geminiPlanRosterKin, geminiPlanRosterKinWords, geminiPlanWireModel, refreshGeminiCatalogue, type GeminiPlanRosterKin } from './geminiCatalogue.js'
import { clearGeminiUsageLimit, recordGeminiRateHeaders } from './geminiUsageState.js'
import type { CompatStreamEvent } from '../openaicompat/compatChatClient.js'
import { geminiPlanStreamUrl, streamGeminiContent, type GeminiPlanWire } from './geminiClient.js'
import { geminiPlanServesClaude, type GeminiTurnItem } from './geminiCodec.js'
import { qualifiedWireId } from '../routeLaw.js'
import { unansweredRefusals } from '../toolCallGate.js'
import { mapMessagesToZai } from '../zai/zaiCodec.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../api/errors.js'
import { createAssistantAPIErrorMessage } from '../../../utils/messages.js'
import { compatDispatchModelId } from '../openaicompat/compatChatCallModel.js'
import { fitOutputTokensForRequest, outputFitWords } from '../../api/outputFit.js'
import { logForDebugging } from '../../../utils/debug.js'

function bearerFromAuthHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers['authorization'] ?? headers['Authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return headers['x-goog-api-key']
}

export const geminiLaneProfile: CompatLaneProfile = {
  lane: 'gemini',
  providerLabel: 'Gemini',
  resolveCredential: async () => {
    const auth = await resolveGeminiRequestAuth({ sourceKind: 'api-key' })
    if (!auth) return undefined
    const bearer = bearerFromAuthHeaders(auth.headers)
    return bearer ? { apiKey: bearer } : undefined
  },
  recoverCredential: async () => {
    if (!configuredProviderKeyCommand('gemini')) return null
    const fresh = recoverProviderKeyCommand('gemini')
    return fresh ? { apiKey: fresh } : undefined
  },
  get credentialHint(): string {
    const failure = providerKeyCommandFailure('gemini')
    return failure ? `the configured ${failure.message} — no Gemini credential detected.` : 'no Gemini credential detected — /logins adds Gemini (API key, or Google OAuth with your own client).'
  },
  authRemedy:
    'set a valid GEMINI_API_KEY (or GOOGLE_API_KEY), or /logins reconnects Gemini — a fresh key, or the Google account again.',
  billingRemedy:
    'check the billing and quota of the Google Cloud project behind this key, then retry; /model picks another model meanwhile.',
  requestUrl: () => `${geminiApiBase()}/openai/chat/completions`,
  wireModelId: modelId => modelId,

  buildExtras: args =>
    buildGeminiExtras({
      ...args,
      acceptsEffort: geminiEffortVocabularyFor(args.wireModel).length > 0,
    }),
  onResponseHeaders: (headers, status) => {
    recordGeminiRateHeaders(headers)
    if (status !== undefined && status >= 200 && status < 300) clearGeminiUsageLimit()
  },
}

export const GEMINI_ACCOUNT_BILLING_REMEDY =
  "the Google sign-in's quota and billing cannot be changed from here · /logins adds a Gemini API key on a project of your own; /model picks another model meanwhile."

export function geminiLiveProofState(): { at: number; model: string } | null {
  return compatLaneLiveProofState('gemini')
}

const GEMINI_PLAN_AUTH_REMEDY =
  "the Google sign-in's token was refused · /logins → Sign in with Google signs in again; /model picks another model meanwhile."
const GEMINI_PLAN_BILLING_REMEDY =
  "the plan's quota is Google's and cannot be changed from here · /usage shows the tier Google reports and the wait Google asks for; /logins adds a Gemini API key on a project of your own; /model picks another model meanwhile."

const GEMINI_PLAN_BARE_INVALID_ARGUMENT = 'Request contains an invalid argument.'

interface GeminiPlanRefusalFacts {
  model: string
  status: number | undefined
  elapsedMs: number
  attempts: Array<'same' | 'plain'>
  wireSaid: string | undefined
}

function geminiPlanRefusalPlaceWords(facts: Pick<GeminiPlanRefusalFacts, 'status' | 'elapsedMs'>): string {
  const seconds = `${Math.max(1, Math.round(facts.elapsedMs / 1000))} s`
  return facts.status !== undefined && facts.status >= 200 && facts.status < 300
    ? `in flight at ${seconds} — the request was accepted and the refusal came while the model answered`
    : `HTTP ${facts.status ?? '?'} after ${seconds}, before any answer byte`
}

function geminiPlanInvalidArgumentWords(facts: GeminiPlanRefusalFacts): string {
  const attempts = facts.attempts.length === 1 ? 'not retried' : `retried ${facts.attempts.length === 2 ? 'once' : 'twice'} (${facts.attempts.slice(1).map(kind => (kind === 'plain' ? 'plain function calling' : 'the same shape')).join(', then ')})`
  return `${API_ERROR_MESSAGE_PREFIX}: Google refused the request on '${facts.model}' — ${geminiPlanRefusalPlaceWords(facts)} (INVALID_ARGUMENT, no detail); ${attempts}. Send again, or /model picks another roster row meanwhile.${facts.wireSaid === undefined ? '' : ` The wire said: ${facts.wireSaid}`}`
}

export function geminiPlanModelMissingWords(model: string, status: number | undefined, wireSaid: string | undefined, kin: GeminiPlanRosterKin = geminiPlanRosterKin(model)): string {
  return `${API_ERROR_MESSAGE_PREFIX}: Google serves no model '${model}' to this Google sign-in${status === undefined ? '' : ` (HTTP ${status})`}${geminiPlanRosterKinWords(kin)} · /model lists the roster Google serves it; /logins → Sign in with Google reads the roster again if the plan changed.${wireSaid === undefined ? '' : ` The wire said: ${wireSaid}`}`
}

const planSession = { agentId: randomUUID(), trajectoryId: randomUUID(), sessionId: `-${Date.now()}${Math.floor(Math.random() * 1e6)}`, step: 1 }
const planLastGoodBase = new Map<string, string>()

export function nextGeminiPlanEnvelope(projectId: string, wireModel = ''): Omit<GeminiPlanWire, 'bases' | 'userAgent' | 'onServedBy'> {
  planSession.step += 1
  const step = planSession.step
  const claude = String(geminiPlanServesClaude(wireModel))
  return {
    projectId,
    requestId: `agent/${planSession.agentId}/${Date.now()}/${planSession.trajectoryId}/${step}`,
    sessionId: planSession.sessionId,
    labels: { last_step_index: String(step - 1), trajectory_id: planSession.trajectoryId, used_claude: claude, used_claude_conservative: claude },
  }
}

export function orderedGeminiPlanBases(projectId: string, bases: readonly string[]): string[] {
  const lastGood = planLastGoodBase.get(projectId)
  return lastGood !== undefined && bases.includes(lastGood) ? [lastGood, ...bases.filter(base => base !== lastGood)] : [...bases]
}

export function __resetGeminiPlanWireForTest(): void {
  planLastGoodBase.clear()
  planSession.step = 1
}

async function* geminiPlanCallModel(params: CallModelParams): CallModelStream {
  const model = compatDispatchModelId(params.options.model)
  const effort = params.options.effortValue
  const wireOf = (id: string): string => geminiPlanWireModel(qualifiedWireId(id), typeof effort === 'string' ? effort : undefined)
  let bearer: string | undefined
  let status: number | undefined
  let recovery: 'retried' | 'no-new-credential' | undefined
  let wireSaid: string | undefined
  let projectId: string | undefined
  let bases: string[] = []
  let userAgent = ''
  const credentialOf = async (forceRefresh: boolean) => {
    const auth = await resolveGeminiRequestAuth({ sourceKind: 'plan', ...(forceRefresh ? { forceRefresh: true } : {}) })
    if (!auth?.plan) return undefined
    projectId = auth.plan.projectId
    bases = orderedGeminiPlanBases(auth.plan.projectId, auth.plan.bases)
    userAgent = auth.headers['user-agent'] ?? ''
    const fresh = bearerFromAuthHeaders(auth.headers)
    return fresh ? { apiKey: fresh, requestUrl: geminiPlanStreamUrl(bases[0]!, true) } : undefined
  }
  const profile: CompatLaneProfile = {
    ...geminiLaneProfile,
    credentialHint: 'no Google sign-in for Gemini — /logins → Sign in with Google.',
    authRemedy: GEMINI_PLAN_AUTH_REMEDY,
    billingRemedy: GEMINI_PLAN_BILLING_REMEDY,
    wireModelId: modelId => wireOf(modelId),
    buildExtras: args => buildGeminiExtras({ ...args, acceptsEffort: geminiEffortVocabularyFor(model).length > 0 || geminiEffortVocabularyFor(args.wireModel).length > 0 }),
    resolveCredential: async () => {
      const credential = await credentialOf(false)
      bearer = credential?.apiKey
      return credential
    },
    recoverCredential: async () => {
      recovery = 'no-new-credential'
      const credential = await credentialOf(true)
      if (credential && credential.apiKey !== bearer) recovery = 'retried'
      return credential
    },
    onResponseHeaders: (headers, responseStatus) => {
      status = responseStatus
      recordGeminiRateHeaders(headers)
      if (responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300) clearGeminiUsageLimit()
    },
    streamTransport: (options, messages) => {
      let turn: GeminiTurnItem | undefined
      attemptStartedAt = Date.now()
      const project = projectId ?? ''
      const plan: GeminiPlanWire = {
        ...nextGeminiPlanEnvelope(project, options.request.model),
        ...(plainTools ? { toolMode: 'AUTO' as const } : {}),
        bases,
        userAgent,
        onServedBy: base => planLastGoodBase.set(project, base),
      }
      const ceiling = geminiOutputTokenLimitFor(options.request.model) ?? geminiOutputTokenLimitFor(model)
      const requested = options.request.extra?.max_tokens
      const capped = ceiling === undefined ? requested : Math.min(typeof requested === 'number' ? requested : ceiling, ceiling)
      const fit = typeof capped === 'number'
        ? fitOutputTokensForRequest({ asked: capped, messages, model, fixed: [options.request.messages.filter(row => row.role === 'system'), options.request.tools] })
        : undefined
      if (fit?.clamped === true) logForDebugging(outputFitWords(fit, model))
      const fitted = fit?.tokens ?? capped
      const request = fitted === undefined ? options.request : { ...options.request, extra: { ...options.request.extra, max_tokens: fitted } }
      const upstream = streamGeminiContent({ ...options, request, messages, plan, onTurn: item => { turn = item } })
      async function* observed(): AsyncGenerator<CompatStreamEvent> {
        for await (const event of upstream) {
          if (event.type === 'stream-fault') wireSaid = event.fault.message ? `${event.fault.code}: ${event.fault.message}` : event.fault.code
          yield event
        }
      }
      return {
        events: observed(),
        settle: minted => {
          const last = minted.at(-1)
          if (!last || !turn) return
          const content = minted.flatMap(message => message.message.content)
          const projection = JSON.stringify(mapMessagesToZai(undefined, [{ role: 'assistant', content }])[0])
          const refused = unansweredRefusals(minted).map(call => ({ id: call.id, reason: call.reason }))
          last.geminiProviderTurn = { ...turn, projection, ...(refused.length ? { refused } : {}) }
        },
      }
    },
  }
  let plainTools = false
  let attemptStartedAt = Date.now()
  const attempts: Array<'same' | 'plain'> = []
  const lastWire = (): { said: string | undefined; seen: number | undefined; elapsedMs: number } => ({ said: wireSaid, seen: status, elapsedMs: Date.now() - attemptStartedAt })
  await rosterReadBounded(false, GEMINI_PLAN_ROSTER_WAIT_MS)
  for (let attempt = 0; attempt < 3; attempt++) {
    status = undefined
    wireSaid = undefined
    attempts.push(plainTools ? 'plain' : 'same')
    let rerun = false
    for await (const item of compatChatCallModel(profile, params)) {
      const { said, seen, elapsedMs } = lastWire()
      if (item.type === 'assistant' && item.isApiErrorMessage && said !== undefined && said.startsWith('api-INVALID_ARGUMENT')) {
        const inFlight = seen !== undefined && seen >= 200 && seen < 300
        const bare = said.endsWith(GEMINI_PLAN_BARE_INVALID_ARGUMENT)
        if ((inFlight || bare) && attempt < 2) {
          plainTools = attempt === 1
          rerun = true
          break
        }
        yield createAssistantAPIErrorMessage({
          content: inFlight || bare
            ? geminiPlanInvalidArgumentWords({ model, status: seen, elapsedMs, attempts: [...attempts], wireSaid: said })
            : `${API_ERROR_MESSAGE_PREFIX}: Google refused the request on '${model}' — ${geminiPlanRefusalPlaceWords({ status: seen, elapsedMs })} (INVALID_ARGUMENT, with detail; not retried). The wire said: ${said}`,
          error: item.error,
          errorDetails: item.errorDetails,
        })
        continue
      }
      if (item.type === 'assistant' && item.isApiErrorMessage && item.error === 'authentication_failed') {
        const refreshed = recovery === 'retried'
          ? ' The stored token was refreshed and the call retried once before this refusal.'
          : recovery === 'no-new-credential' ? ' A token refresh was attempted first and produced no new credential.' : ''
        yield createAssistantAPIErrorMessage({
          content: `${API_ERROR_MESSAGE_PREFIX}: the Google sign-in's token was refused${status === undefined ? '' : ` (HTTP ${status})`} · /logins → Sign in with Google signs in again; /model picks another model meanwhile.${refreshed}${wireSaid === undefined ? '' : ` The wire said: ${wireSaid}`}`,
          error: item.error,
          errorDetails: item.errorDetails,
        })
      } else if (item.type === 'assistant' && item.isApiErrorMessage && status === 404) {
        if (attempt === 0) {
          const before = wireOf(model)
          await rosterReadBounded(true, GEMINI_PLAN_ROSTER_REREAD_MS)
          if (wireOf(model) !== before) {
            rerun = true
            break
          }
        }
        yield createAssistantAPIErrorMessage({
          content: geminiPlanModelMissingWords(model, status, wireSaid),
          error: item.error,
          errorDetails: item.errorDetails,
        })
      } else yield item
    }
    if (!rerun) return
  }
}

const GEMINI_PLAN_ROSTER_WAIT_MS = 2_000
const GEMINI_PLAN_ROSTER_REREAD_MS = 5_000

async function rosterReadBounded(force: boolean, waitMs: number): Promise<void> {
  const read = refreshGeminiCatalogue('plan', force ? { force: true } : undefined).then(() => undefined, () => undefined)
  await Promise.race([read, new Promise<void>(resolve => setTimeout(resolve, waitMs).unref?.())])
}

export async function* geminiCallModel(params: CallModelParams): CallModelStream {
  const kind = resolveGeminiAccount()?.kind
  if (kind === 'plan') {
    yield* geminiPlanCallModel(params)
    return
  }
  if (kind === undefined) {
    yield* compatChatCallModel(geminiLaneProfile, params)
    return
  }
  const model = compatDispatchModelId(params.options.model)
  let bearer: string | undefined
  let status: number | undefined
  let recovery: 'retried' | 'no-new-credential' | undefined
  let wireSaid: string | undefined
  const nativeUrl = (base: string): string => `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
  const profile: CompatLaneProfile = {
    ...geminiLaneProfile,
    ...(kind === 'oauth' ? { billingRemedy: GEMINI_ACCOUNT_BILLING_REMEDY } : {}),
    resolveCredential: async () => {
      const auth = await resolveGeminiRequestAuth({ sourceKind: kind })
      if (!auth) return undefined
      bearer = bearerFromAuthHeaders(auth.headers)
      return bearer ? { apiKey: bearer, requestUrl: nativeUrl(auth.baseUrl) } : undefined
    },
    ...(kind === 'oauth'
      ? {
          recoverCredential: async () => {
            recovery = 'no-new-credential'
            const auth = await resolveGeminiRequestAuth({ sourceKind: 'oauth', forceRefresh: true })
            if (!auth) return undefined
            const fresh = bearerFromAuthHeaders(auth.headers)
            if (fresh && fresh !== bearer) recovery = 'retried'
            return fresh ? { apiKey: fresh, requestUrl: nativeUrl(auth.baseUrl) } : undefined
          },
        }
      : {
          recoverCredential: async () => {
            if (!configuredProviderKeyCommand('gemini')) return null
            const fresh = recoverProviderKeyCommand('gemini', bearer)
            return fresh ? { apiKey: fresh, requestUrl: nativeUrl(geminiApiBase()) } : undefined
          },
        }),
    onResponseHeaders: (headers, responseStatus) => {
      status = responseStatus
      recordGeminiRateHeaders(headers)
      if (responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300) clearGeminiUsageLimit()
    },
    streamTransport: (options, messages) => {
      let turn: GeminiTurnItem | undefined
      const upstream = streamGeminiContent({ ...options, messages, ...(kind === 'api-key' ? { apiKeyHeader: true } : {}), onTurn: item => { turn = item } })
      async function* observed(): AsyncGenerator<CompatStreamEvent> {
        for await (const event of upstream) {
          if (event.type === 'stream-fault') wireSaid = event.fault.message ? `${event.fault.code}: ${event.fault.message}` : event.fault.code
          yield event
        }
      }
      return {
        events: observed(),
        settle: minted => {
          const last = minted.at(-1)
          if (!last || !turn) return
          const content = minted.flatMap(message => message.message.content)
          const projection = JSON.stringify(mapMessagesToZai(undefined, [{ role: 'assistant', content }])[0])
          const refused = unansweredRefusals(minted).map(call => ({ id: call.id, reason: call.reason }))
          last.geminiProviderTurn = { ...turn, projection, ...(refused.length ? { refused } : {}) }
        },
      }
    },
  }
  for await (const item of compatChatCallModel(profile, params)) {
    if (kind === 'oauth' && item.type === 'assistant' && item.isApiErrorMessage && item.error === 'authentication_failed') {
      const refreshed = recovery === 'retried'
        ? ' The stored token was refreshed and the call retried once before this refusal.'
        : recovery === 'no-new-credential' ? ' A token refresh was attempted first and produced no new credential.' : ''
      yield createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: the Google account's token was refused${status === undefined ? '' : ` (HTTP ${status})`} · /logins re-connects the Google account; /model picks another model meanwhile.${refreshed}${wireSaid === undefined ? '' : ` The wire said: ${wireSaid}`}`,
        error: item.error,
        errorDetails: item.errorDetails,
      })
    } else yield item
  }
}
