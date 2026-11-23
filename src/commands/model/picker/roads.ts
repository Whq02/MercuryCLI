import { useLoad } from '../../../hooks/effects.js'
import { isDeepStrictEqual } from 'node:util'
import { getCachedOpenrouterCatalogue, refreshOpenrouterCatalogue, type OpenrouterCatalogueSnapshot } from '../../../services/providers/openrouter/openrouterCatalogue.js'
import { resolveOpenrouterRequestAuth } from '../../../services/providers/openrouter/openrouterAccounts.js'
import { getCachedNousCatalogue, refreshNousCatalogue, type NousCatalogueSnapshot } from '../../../services/providers/nous/nousCatalogue.js'
import { nousApiBase, resolveNousApiKey } from '../../../services/providers/nous/nousAccounts.js'
import { credentialFingerprint } from '../../../utils/accounts/credentialIdentity.js'
import { getCachedGeminiCatalogue, refreshGeminiCatalogue, type GeminiCatalogueSnapshot } from '../../../services/providers/gemini/geminiCatalogue.js'
import { geminiSourceIdentity, resolveGeminiAccount } from '../../../services/providers/gemini/geminiAccounts.js'
import { ANTHROPIC_DOOR_LABELS, anthropicDoors, getCachedAnthropicDoorCatalogue, refreshAnthropicCatalogue, type AnthropicDoor, type AnthropicDoorSnapshot } from '../../../services/providers/anthropic/anthropicCatalogue.js'
import { getCachedHuggingfaceCatalogue, refreshHuggingfaceCatalogue, type HuggingfaceCatalogueSnapshot } from '../../../services/providers/huggingface/huggingfaceCatalogue.js'
import { resolveHuggingfaceApiKey } from '../../../services/providers/huggingface/huggingfaceAccounts.js'
import { getCachedMoonshotCatalogue, refreshMoonshotCatalogue, type MoonshotCatalogueSnapshot } from '../../../services/providers/moonshot/moonshotCatalogue.js'
import { kimiAccountKey, kimiCodingBase, moonshotApiBase, moonshotStoredTokens, resolveMoonshotAccount, resolveMoonshotApiKey } from '../../../services/providers/moonshot/moonshotAccounts.js'
import { getCachedDeepseekCatalogue, refreshDeepseekCatalogue, type DeepseekCatalogueSnapshot } from '../../../services/providers/deepseek/deepseekCatalogue.js'
import { deepseekApiBase, resolveDeepseekApiKey } from '../../../services/providers/deepseek/deepseekAccounts.js'
import { getCachedZaiCatalogue, refreshZaiCatalogue, type ZaiCatalogueSnapshot } from '../../../services/providers/zai/zaiCatalogue.js'
import { zaiApiBase } from '../../../services/providers/zai/zaiClient.js'
import { resolveZaiDispatch } from '../../../services/providers/providerDiscovery.js'
import { getCachedXaiCatalogue, refreshXaiCatalogue, type XaiCatalogueSnapshot } from '../../../services/providers/xai/xaiCatalogue.js'
import { resolveXaiCredentialSnapshot, xaiInferenceBase } from '../../../services/providers/xai/xaiAccounts.js'
import { getCachedMetaCatalogue, refreshMetaCatalogue, type MetaCatalogueSnapshot } from '../../../services/providers/meta/metaCatalogue.js'
import { metaApiBase, resolveMetaApiKey } from '../../../services/providers/meta/metaAccounts.js'
import { getCachedMistralCatalogue, refreshMistralCatalogue, type MistralCatalogueSnapshot } from '../../../services/providers/mistral/mistralCatalogue.js'
import { mistralApiBase, resolveMistralApiKey } from '../../../services/providers/mistral/mistralAccounts.js'
import { getCachedMinimaxCatalogue, refreshMinimaxCatalogue, type MinimaxCatalogueSnapshot } from '../../../services/providers/minimax/minimaxCatalogue.js'
import { minimaxApiBase, resolveMinimaxApiKey } from '../../../services/providers/minimax/minimaxAccounts.js'
import { getCachedTogetherCatalogue, refreshTogetherCatalogue, type TogetherCatalogueSnapshot } from '../../../services/providers/together/togetherCatalogue.js'
import { resolveTogetherApiKey, togetherApiBase } from '../../../services/providers/together/togetherAccounts.js'
import { getCachedCohereCatalogue, refreshCohereCatalogue, type CohereCatalogueSnapshot } from '../../../services/providers/cohere/cohereCatalogue.js'
import { cohereApiBase, resolveCohereApiKey } from '../../../services/providers/cohere/cohereAccounts.js'
import { getCachedGroqCatalogue, refreshGroqCatalogue, type GroqCatalogueSnapshot } from '../../../services/providers/groq/groqCatalogue.js'
import { getCachedMeliousCatalogue, refreshMeliousCatalogue, type MeliousCatalogueSnapshot } from '../../../services/providers/melious/meliousCatalogue.js'
import { groqApiBase, resolveGroqApiKey } from '../../../services/providers/groq/groqAccounts.js'
import { meliousApiBase, resolveMeliousApiKey } from '../../../services/providers/melious/meliousAccounts.js'
import { getCachedCerebrasCatalogue, refreshCerebrasCatalogue, type CerebrasCatalogueSnapshot } from '../../../services/providers/cerebras/cerebrasCatalogue.js'
import { cerebrasApiBase, resolveCerebrasApiKey } from '../../../services/providers/cerebras/cerebrasAccounts.js'
import { getCachedFireworksCatalogue, refreshFireworksCatalogue, type FireworksCatalogueSnapshot } from '../../../services/providers/fireworks/fireworksCatalogue.js'
import { fireworksApiBase, resolveFireworksApiKey } from '../../../services/providers/fireworks/fireworksAccounts.js'
import { getCachedQwenCatalogue, qwenCatalogueIdentity, refreshQwenCatalogue, type QwenCatalogueSnapshot } from '../../../services/providers/qwen/qwenCatalogue.js'
import { getCachedLocalDiscovery, localProbeTargets, refreshLocalDiscovery, type LocalDiscoverySnapshot } from '../../../services/providers/local/localDiscovery.js'
import { getCachedOpenaiCatalogue, refreshOpenaiCatalogue, type OpenaiCatalogueSnapshot } from '../../../services/providers/openai/openaiCatalogue.js'
import { openaiSourceIdentity, resolveOpenaiAccount } from '../../../services/providers/openai/openaiAccounts.js'
import { passedOver } from '../../../utils/passedOver.js'
import { hostEnv } from '../../../utils/hostEnv.js'

type CatalogueRoad<S> = {
  family: string
  identity: () => string | undefined
  cached: () => S | null
  refresh: () => Promise<S | null>
  populated: (snapshot: S) => boolean
  failed: (snapshot: S) => boolean
  changed: (before: S, after: S) => boolean
}

const byPriority = (models: OpenaiCatalogueSnapshot['models']): OpenaiCatalogueSnapshot['models'] =>
  models.toSorted((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))

export const GPT_ROAD: CatalogueRoad<OpenaiCatalogueSnapshot> = {
  family: 'GPT',
  identity: () => {
    const account = resolveOpenaiAccount()
    return account ? `${account.kind}:${openaiSourceIdentity(account.kind)}` : undefined
  },
  cached: () => {
    const account = resolveOpenaiAccount()
    return account ? getCachedOpenaiCatalogue(account.kind) : null
  },
  refresh: () => {
    const account = resolveOpenaiAccount()
    return account ? refreshOpenaiCatalogue(account.kind, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(byPriority(before.models), byPriority(after.models)),
}

export const OPENROUTER_ROAD: CatalogueRoad<OpenrouterCatalogueSnapshot> = {
  family: 'OpenRouter',
  identity: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? `${auth.account.keySource}:${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}` : undefined
  },
  cached: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? getCachedOpenrouterCatalogue(auth.account.keySource) : null
  },
  refresh: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? refreshOpenrouterCatalogue(auth.account.keySource, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

const geminiSourceKind = (): 'oauth' | 'api-key' | 'plan' | undefined => {
  const account = resolveGeminiAccount()
  return account?.kind
}

export const GEMINI_ROAD: CatalogueRoad<GeminiCatalogueSnapshot> = {
  family: 'Gemini',
  identity: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? `${sourceKind}:${geminiSourceIdentity(sourceKind)}` : undefined
  },
  cached: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? getCachedGeminiCatalogue(sourceKind) : null
  },
  refresh: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? refreshGeminiCatalogue(sourceKind, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

function anthropicDoorRoad(door: AnthropicDoor): CatalogueRoad<AnthropicDoorSnapshot> {
  const credential = (): { fingerprint: string } | undefined => anthropicDoors().find(candidate => candidate.door === door)
  return {
    family: ANTHROPIC_DOOR_LABELS[door],
    identity: () => {
      const found = credential()
      return found ? `${door}:${found.fingerprint}` : undefined
    },
    cached: () => (credential() ? getCachedAnthropicDoorCatalogue(door) : null),
    refresh: () => (credential() ? refreshAnthropicCatalogue({ door, force: true }).then(snapshots => snapshots[0] ?? null) : Promise.resolve(null)),
    populated: snapshot => snapshot.models.length > 0,
    failed: snapshot => snapshot.lastError !== undefined,
    changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
  }
}

export const ANTHROPIC_SUBSCRIPTION_ROAD = anthropicDoorRoad('subscription')
export const ANTHROPIC_KEY_ROAD = anthropicDoorRoad('api-key')
export const ANTHROPIC_BEARER_ROAD = anthropicDoorRoad('bearer')

export const NOUS_ROAD: CatalogueRoad<NousCatalogueSnapshot> = {
  family: 'Nous Portal',
  identity: () => {
    const key = resolveNousApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${nousApiBase()}` : undefined
  },
  cached: () => getCachedNousCatalogue(),
  refresh: () => refreshNousCatalogue({ force: true }),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const HUGGINGFACE_ROAD: CatalogueRoad<HuggingfaceCatalogueSnapshot> = {
  family: 'Hugging Face',
  identity: () => {
    const credential = resolveHuggingfaceApiKey()
    return credential ? `${credential.source}:${credentialFingerprint(credential.key)}` : undefined
  },
  cached: () => (resolveHuggingfaceApiKey() ? getCachedHuggingfaceCatalogue() : null),
  refresh: () => (resolveHuggingfaceApiKey() ? refreshHuggingfaceCatalogue({ force: true }) : Promise.resolve(null)),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const MOONSHOT_ROAD: CatalogueRoad<MoonshotCatalogueSnapshot> = {
  family: 'Moonshot',
  identity: () => {
    const account = resolveMoonshotAccount()
    if (!account) return undefined
    if (account.kind === 'kimi-oauth') {
      const tokens = moonshotStoredTokens()
      return tokens ? `kimi-oauth:${kimiAccountKey(tokens)}:${kimiCodingBase(account.region)}` : undefined
    }
    return `${account.keySource}:${credentialFingerprint(resolveMoonshotApiKey()?.key ?? '')}:${moonshotApiBase()}`
  },
  cached: () => getCachedMoonshotCatalogue(),
  refresh: () => refreshMoonshotCatalogue({ force: true }),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const DEEPSEEK_ROAD: CatalogueRoad<DeepseekCatalogueSnapshot> = {
  family: 'DeepSeek',
  identity: () => {
    const key = resolveDeepseekApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${deepseekApiBase()}` : undefined
  },
  cached: () => getCachedDeepseekCatalogue(),
  refresh: () => refreshDeepseekCatalogue({ force: true }),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const ZAI_ROAD: CatalogueRoad<ZaiCatalogueSnapshot> = {
  family: 'Z.AI',
  identity: () => {
    const dispatch = resolveZaiDispatch()
    return dispatch ? `${dispatch.source}:${credentialFingerprint(dispatch.key)}:${zaiApiBase(hostEnv(), dispatch.plan)}` : undefined
  },
  cached: () => getCachedZaiCatalogue(),
  refresh: () => refreshZaiCatalogue({ force: true }),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const XAI_ROAD: CatalogueRoad<XaiCatalogueSnapshot> = {
  family: 'xAI',
  identity: () => {
    const key = resolveXaiCredentialSnapshot()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${xaiInferenceBase(key.source)}` : undefined
  },
  cached: () => getCachedXaiCatalogue(),
  refresh: () => refreshXaiCatalogue({ force: true }),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const META_ROAD: CatalogueRoad<MetaCatalogueSnapshot> = {
  family: 'Meta',
  identity: () => {
    const key = resolveMetaApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${metaApiBase()}` : undefined
  },
  cached: () => getCachedMetaCatalogue(),
  refresh: () => refreshMetaCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const MINIMAX_ROAD: CatalogueRoad<MinimaxCatalogueSnapshot> = {
  family: 'MiniMax',
  identity: () => {
    const key = resolveMinimaxApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${minimaxApiBase()}` : undefined
  },
  cached: () => getCachedMinimaxCatalogue(),
  refresh: () => refreshMinimaxCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const TOGETHER_ROAD: CatalogueRoad<TogetherCatalogueSnapshot> = {
  family: 'Together AI',
  identity: () => {
    const key = resolveTogetherApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${togetherApiBase()}` : undefined
  },
  cached: () => getCachedTogetherCatalogue(),
  refresh: () => refreshTogetherCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const COHERE_ROAD: CatalogueRoad<CohereCatalogueSnapshot> = {
  family: 'Cohere',
  identity: () => {
    const key = resolveCohereApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${cohereApiBase()}` : undefined
  },
  cached: () => getCachedCohereCatalogue(),
  refresh: () => refreshCohereCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const GROQ_ROAD: CatalogueRoad<GroqCatalogueSnapshot> = {
  family: 'Groq',
  identity: () => {
    const key = resolveGroqApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${groqApiBase()}` : undefined
  },
  cached: () => getCachedGroqCatalogue(),
  refresh: () => refreshGroqCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}
export const MELIOUS_ROAD: CatalogueRoad<MeliousCatalogueSnapshot> = {
  family: 'Melious AI',
  identity: () => {
    const key = resolveMeliousApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${meliousApiBase()}` : undefined
  },
  cached: () => getCachedMeliousCatalogue(),
  refresh: () => refreshMeliousCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}
export const CEREBRAS_ROAD: CatalogueRoad<CerebrasCatalogueSnapshot> = {
  family: 'Cerebras',
  identity: () => {
    const key = resolveCerebrasApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${cerebrasApiBase()}` : undefined
  },
  cached: () => getCachedCerebrasCatalogue(),
  refresh: () => refreshCerebrasCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}
export const FIREWORKS_ROAD: CatalogueRoad<FireworksCatalogueSnapshot> = {
  family: 'Fireworks',
  identity: () => {
    const key = resolveFireworksApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${fireworksApiBase()}` : undefined
  },
  cached: () => getCachedFireworksCatalogue(),
  refresh: () => refreshFireworksCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}
export const QWEN_ROAD: CatalogueRoad<QwenCatalogueSnapshot> = {
  family: 'Qwen',
  identity: () => qwenCatalogueIdentity(),
  cached: () => getCachedQwenCatalogue(),
  refresh: () => refreshQwenCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}
export const MISTRAL_ROAD: CatalogueRoad<MistralCatalogueSnapshot> = {
  family: 'Mistral',
  identity: () => {
    const key = resolveMistralApiKey()
    return key ? `${key.source}:${credentialFingerprint(key.key)}:${mistralApiBase()}` : undefined
  },
  cached: () => getCachedMistralCatalogue(),
  refresh: () => refreshMistralCatalogue({ force: true }),
  populated: snapshot => snapshot.fetchedAtMs > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

export const LOCAL_ROAD: CatalogueRoad<LocalDiscoverySnapshot> = {
  family: 'Local',
  identity: () => {
    const targets = localProbeTargets()
    return targets.length === 0 ? undefined : targets.map(target => `${target.kind}=${target.root}`).join(',')
  },
  cached: () => getCachedLocalDiscovery(),
  refresh: () => refreshLocalDiscovery({ force: true }),
  populated: snapshot => snapshot.servers.some(server => server.models.length > 0),
  failed: () => false,
  changed: (before, after) => !isDeepStrictEqual(before.servers, after.servers),
}

export function useCatalogueRefreshOnOpen<S>(road: CatalogueRoad<S>, setNotice: (notice: string) => void): void {
  const identity = road.identity()
  useLoad(signal => {
    if (identity === undefined) return
    const before = road.cached()
    void road.refresh().then(snapshot => {
      if (
        !signal.aborted && before !== null && road.populated(before) && snapshot !== null && !road.failed(snapshot) &&
        road.identity() === identity && road.cached() === snapshot && road.changed(before, snapshot)
      ) {
        setNotice(`${road.family} — the live list changed; rows updated`)
      }
    }, passedOver)
  }, [road, identity, setNotice])
}
