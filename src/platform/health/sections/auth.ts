import { getAnthropicApiKeyWithSource, getAuthTokenSource } from '../../../models/sign-in/credentials/auth.js'
import { buildProviderSnapshot } from '../../../models/roads/modelRegistry.js'
import { getEngineModel, getUserSpecifiedModelSetting } from '../../../models/catalogue/engineModel.js'
import { computedDefault, mostRecentSignInFamily } from '../../../models/catalogue/computedDefault.js'
import { tensorFoldHealthChecks, unresolvedDefaultRow, type CheckSpec } from '../healthReport.js'
import { passedOver } from '../../errors/passedOver.js'

const PROVIDER_AUTH_PRESENTATION: Record<string, { label: string; signIn: string }> = {
  anthropic: { label: 'Anthropic', signIn: 'Run /logins (or export ANTHROPIC_API_KEY)' },
  openai: {
    label: 'OpenAI',
    signIn: 'Connect via /logins (browser or device code)',
  },
  zai: { label: 'Z.AI', signIn: 'Add a Z.AI API key via /logins zai, or export ZAI_API_KEY' },
  moonshot: {
    label: 'Moonshot',
    signIn: 'Sign in via /logins moonshot (Kimi, or an API key), or export MOONSHOT_API_KEY',
  },
  meta: {
    label: 'Meta',
    signIn: 'Add a Meta Model API key via /logins meta, or export MODEL_API_KEY',
  },
  mistral: {
    label: 'Mistral',
    signIn: 'Add a Mistral API key via /logins mistral, or export MISTRAL_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    signIn: 'Add a DeepSeek API key via /logins deepseek, or export DEEPSEEK_API_KEY',
  },
  xai: {
    label: 'xAI',
    signIn: 'Add an xAI API key via /logins xai, or export XAI_API_KEY',
  },
  nous: {
    label: 'Nous Portal',
    signIn: 'Add a Nous Portal API key via /logins nous, or export NOUS_API_KEY',
  },
  minimax: {
    label: 'MiniMax',
    signIn: 'Add a MiniMax API key via /logins minimax, or export MINIMAX_API_KEY',
  },
  together: {
    label: 'Together AI',
    signIn: 'Add a Together AI API key via /logins together, or export TOGETHER_API_KEY',
  },
  cohere: {
    label: 'Cohere',
    signIn: 'Add a Cohere API key via /logins cohere, or export COHERE_API_KEY',
  },
  groq: { label: 'Groq', signIn: 'Add a Groq API key via /logins groq, or export GROQ_API_KEY' },
  melious: { label: 'Melious AI', signIn: 'Add a Melious AI API key via /logins melious, or export MELIOUS_API_KEY' },
  orcarouter: { label: 'OrcaRouter', signIn: 'Add an OrcaRouter API key via /logins orcarouter, or export ORCAROUTER_API_KEY' },
  cerebras: { label: 'Cerebras', signIn: 'Add a Cerebras API key via /logins cerebras, or export CEREBRAS_API_KEY' },
  fireworks: { label: 'Fireworks', signIn: 'Add a Fireworks API key via /logins fireworks, or export FIREWORKS_API_KEY' },
  qwen: { label: 'Qwen', signIn: 'Add a QwenCloud or Model Studio API key via /logins qwen, or export DASHSCOPE_API_KEY' },
  'openai-compat': {
    label: 'Custom endpoint',
    signIn: 'Set MERCURY_COMPAT_BASE_URL (key optional — MERCURY_COMPAT_API_KEY)',
  },
}

function routedAuthFamily(): string {
  const { declaredRouteOf } = require('../../../models/roads/routeLaw.js') as typeof import('../../../models/roads/routeLaw.js')
  if (getUserSpecifiedModelSetting() === null) {
    const decision = computedDefault()
    if (decision.provider !== null) return decision.provider
    const signedIn = mostRecentSignInFamily()
    if (signedIn !== undefined) return signedIn
  }
  return declaredRouteOf(getEngineModel()) ?? 'anthropic'
}

function providerAuthChecks(): CheckSpec[] {
  const snap = buildProviderSnapshot()
  let cachedRoutedFamily: string | undefined
  const getRoutedFamily = (): string => (cachedRoutedFamily ??= routedAuthFamily())
  return snap.providers.map((provider): CheckSpec => {
    const meta = PROVIDER_AUTH_PRESENTATION[provider.id] ?? {
      label: provider.id,
      signIn: 'Connect an account for this provider (see /capabilities)',
    }
    if (provider.id === 'anthropic') {
      return {
        id: 'auth-anthropic',
        label: meta.label,
        run: async () => {
          const { checkAnthropicSignInFresh } = await import('../../../models/sign-in/accounts/signInFreshness.js')
          const fresh = await checkAnthropicSignInFresh()
          const { anthropicCredentialPresence } =
            require('../../../models/roads/providerUsage.js') as typeof import('../../../models/roads/providerUsage.js')
          const presence = anthropicCredentialPresence()
          if (!presence.credentialed) {
            const routedFamily = getRoutedFamily()
            if (routedFamily !== 'anthropic') {
              return {
                status: 'info' as const,
                evidence: `absent — no bearer token or API key (session routes to ${routedFamily})`,
                fix: `${meta.signIn}.`,
              }
            }
            return {
              status: 'warn' as const,
              evidence:
                'not signed in — no bearer token or API key (owning resolvers: getAuthTokenSource + getAnthropicApiKeyWithSource)',
              fix: `${meta.signIn} — no turn can run until you sign in.`,
            }
          }
          if (presence.expired || fresh.state === 'expired') {
            const { anthropicSignInWords } =
              require('../../../models/roads/anthropicRefusal.js') as typeof import('../../../models/roads/anthropicRefusal.js')
            return {
              status: 'warn' as const,
              evidence: `${presence.credentialLabel ?? 'claude.ai sign-in'} — sign-in expired`,
              fix: anthropicSignInWords(),
            }
          }
          const tok = getAuthTokenSource()
          if (tok.hasToken) {
            return {
              status: 'ok' as const,
              evidence: fresh.probed && fresh.state === 'valid'
                ? `bearer token via ${tok.source} (renewed on this check)`
                : `bearer token via ${tok.source} (present — validity untested: no network probe by design)`,
            }
          }
          const key = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
          return {
            status: 'ok' as const,
            evidence: `${key.source && key.source !== 'none' ? `API key via ${key.source}` : presence.credentialLabel} (present — validity untested: no network probe by design)`,
          }
        },
      }
    }
    return {
      id: `auth-${provider.id}`,
      label: meta.label,
      run: async () => {
        if (provider.id === 'openai') {
          const { checkOpenaiSignInFresh } = await import('../../../models/sign-in/accounts/signInFreshness.js')
          const fresh = await checkOpenaiSignInFresh()
          if (fresh.state === 'expired') {
            const { credentialWallLine } =
              require('../../../models/roads/credentialWall.js') as typeof import('../../../models/roads/credentialWall.js')
            return {
              status: 'warn' as const,
              evidence: 'ChatGPT subscription — sign-in expired',
              fix: credentialWallLine('openai', 'sign-in'),
            }
          }
        }
        const account = provider.description.account
        if (account.kind === 'none') {
          const routedFamily = getRoutedFamily()
          if (provider.id === routedFamily) {
            return {
              status: 'warn' as const,
              evidence: `not signed in — ${account.label} (the session routes to ${routedFamily}; no turn can run until you sign in)`,
              fix: `${meta.signIn} — no turn can run until you sign in.`,
            }
          }
          return {
            status: 'info' as const,
            evidence: `absent — ${account.label}${provider.reason ? ` (${provider.reason})` : ''}`,
            fix: `${meta.signIn}.`,
          }
        }
        return {
          status: 'ok' as const,
          evidence: `${account.kind} — ${account.label} (present — validity untested: no network probe by design)`,
        }
      },
    }
  })
}

function providerUsageChecks(): CheckSpec[] {
  let owner: typeof import('../../../models/roads/providerUsage.js')
  let presences: ReturnType<typeof owner.providerFamilyPresences>
  try {
    owner = require('../../../models/roads/providerUsage.js') as typeof import('../../../models/roads/providerUsage.js')
    presences = owner.providerFamilyPresences()
  } catch (error) {
    return [{
      id: 'usage',
      label: 'Provider usage',
      run: () => {
        throw error
      },
    }]
  }
  const { providerDisplayName } = require('../../../models/roads/routeLaw.js') as typeof import('../../../models/roads/routeLaw.js')
  return presences
    .filter(presence => presence.credentialed)
    .map((presence): CheckSpec => ({
      id: `usage-${presence.id}`,
      label: `${providerDisplayName(presence.id)} usage`,
      run: () => ({
        status: 'info' as const,
        evidence: `${owner.usageSummaryWords(owner.usageForProvider(presence.id))}${standingWindowWords(presence.id)}`,
      }),
    }))
}

function standingWindowWords(family: string): string {
  if (family !== 'anthropic') return ''
  try {
    const { standingAnthropicRefusal } =
      require('../../../models/roads/anthropicRefusal.js') as typeof import('../../../models/roads/anthropicRefusal.js')
    const standing = standingAnthropicRefusal()
    return standing?.kind === 'window' ? ` · ${standing.words}` : ''
  } catch (error) {
    passedOver(error)
    return ''
  }
}

function modelListsCheck(): CheckSpec {
  return {
    id: 'model-lists',
    label: 'Model lists',
    run: () => {
      const { composeModelListsRow, readModelListFacts } =
        require('../../../models/roads/typedModelIds.js') as typeof import('../../../models/roads/typedModelIds.js')
      return composeModelListsRow(readModelListFacts(), Date.now())
    },
  }
}

export const ENGINE_UNAVAILABLE_CODES: readonly string[] = Object.freeze([
  'discovery-pending:',
  'no-executable:',
  'no-auth:',
  'no-api-key:',
  'no-account:',
  'not-configured:',
  'no-server:',
  'no-credential:',
  'disabled:',
])

function providerSlotsCheck(): CheckSpec {
  return {
    id: 'provider-slots',
    label: 'Provider slots',
    run: async () => {
      const { refreshProviderDiscovery } = await import('../../../models/roads/providerDiscovery.js')
      await Promise.all([
        refreshProviderDiscovery('openai'),
        refreshProviderDiscovery('zai'),
        refreshProviderDiscovery('local'),
      ])
      const { buildProviderSnapshot } = await import('../../../models/roads/modelRegistry.js')
      const snap = buildProviderSnapshot()
      const anthropic = snap.providers.find(p => p.id === 'anthropic')
      const classes = (['opus', 'sonnet', 'fable'] as const).map(c => snap.resolve(c))
      const engines = snap.providers.filter(p => p.id !== 'anthropic')
      const enginesHonest = engines.every(
        p => p.available || ENGINE_UNAVAILABLE_CODES.some(code => p.reason?.startsWith(code)),
      )
      const gptRef = snap.resolve('gpt')
      const glmRef = snap.resolve('glm')
      const seatLawHolds =
        (gptRef === null || (gptRef.provider === 'openai' && gptRef.modelClass === 'gpt')) &&
        (glmRef === null || (glmRef.provider === 'zai' && glmRef.modelClass === 'glm'))
      const ok = anthropic?.available === true && classes.every(c => c !== null) && enginesHonest && seatLawHolds
      const engineWords = new Map<string, string[]>()
      for (const p of engines) {
        const word = p.available ? 'configured' : (p.reason ?? 'unavailable')
        const colon = word.indexOf(':')
        const key = colon >= 0 && word.slice(colon + 1) === p.id ? word.slice(0, colon + 1) : word
        engineWords.set(key, [...(engineWords.get(key) ?? []), p.id])
      }
      const engineLine = [...engineWords].map(([word, ids]) => `${word} ${ids.join(', ')}`).join(' · ')
      const seatLine = gptRef || glmRef
        ? `engine seats: ${[gptRef ? `gpt→${gptRef.model}` : null, glmRef ? `glm→${glmRef.model}` : null].filter(Boolean).join(' · ')} (explicit slots only)`
        : 'engine seats unresolved (no qualified candidate) — defaults stay Anthropic'
      return {
        status: ok ? ('ok' as const) : ('fail' as const),
        evidence: ok
          ? `anthropic configured (${classes.map(c => c!.model).join(' · ')}) · engines: ${engineLine} · ${seatLine}`
          : `provider honesty broke: anthropic=${anthropic?.available} classes=[${classes.map(c => c?.model ?? 'null').join(',')}] engines-honest=${enginesHonest} seat-law=${seatLawHolds} (${engineLine})`,
        ...(ok ? {} : { fix: 'Provider resolution broke an invariant — report this.' }),
      }
    },
  }
}

function webSearchDoorCheck(): CheckSpec {
  return {
    id: 'web-search-door',
    label: 'Web search',
    run: () => {
      const { liveSearchDoorReads, resolveSearchDoorPlan, nativeSearchFamilyOf, searchDoorFact } =
        require('../../../tools/engines/web-search/searchDoor.js') as typeof import('../../../tools/engines/web-search/searchDoor.js')
      const model = unresolvedDefaultRow() ?? getEngineModel()
      const plan = resolveSearchDoorPlan(liveSearchDoorReads())
      if (plan.doors.length === 0 && nativeSearchFamilyOf(model) === undefined) {
        return {
          status: 'info' as const,
          evidence: `no door opens for ${model} — ${plan.closed.join('; ')}`,
          fix: 'BRAVE_API_KEY (or TAVILY_API_KEY) sets a search key; /config turns DuckDuckGo page scraping back on.',
        }
      }
      return { status: 'ok' as const, evidence: `${model}: ${searchDoorFact(model)}` }
    },
  }
}

function extraCaCertsCheck(): CheckSpec {
  return {
    id: 'extra-ca-certs',
    label: 'Extra CA bundle',
    run: () => {
      const { getExtraCaCertsOutcome } = require('../../network/caCerts.js') as typeof import('../../network/caCerts.js')
      const outcome = getExtraCaCertsOutcome()
      if (outcome === null) return { status: 'ok' as const, evidence: 'NODE_EXTRA_CA_CERTS unset — the runtime trust store alone' }
      if (outcome.loaded) return { status: 'ok' as const, evidence: `${outcome.path} read and appended to the bundled roots` }
      return {
        status: 'fail' as const,
        evidence: `${outcome.path} could not be read (${outcome.error ?? 'unreadable'}) — the bundled roots alone are in use; behind TLS interception every request will fail verification`,
        fix: 'Put the bundle back at that path (or point NODE_EXTRA_CA_CERTS at the file that exists) and restart; the variable itself is already set.',
      }
    },
  }
}

export async function authChecks(): Promise<CheckSpec[]> {
  const tensorFoldChecks = await tensorFoldHealthChecks()
  return [...providerAuthChecks(), ...providerUsageChecks(), ...tensorFoldChecks, providerSlotsCheck(), modelListsCheck(), webSearchDoorCheck(), extraCaCertsCheck()]
}
