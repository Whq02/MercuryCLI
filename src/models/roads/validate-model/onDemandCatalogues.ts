import type { ValidateModelResult } from './result.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export async function validateXaiModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveXaiAccount } = await import('../xai/xaiAccounts.js')
  if (!resolveXaiAccount()) return { valid: false, error: 'xAI is unavailable — no API key (/logins xai, or set XAI_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('xai')
  const { getCachedXaiCatalogue } = await import('../xai/xaiCatalogue.js')
  const { isXaiChatModelId } = await import('../../facts/pins/xaiPins.js')
  const snapshot = getCachedXaiCatalogue()
  const id = trimmed.toLowerCase()
  if (id === 'grok') return snapshot?.models.length ? { valid: true, skipCache: true } : { valid: false, error: "xAI's live list has not served a chat model for 'grok' yet — /model refreshes it." }
  if (!isXaiChatModelId(id)) return { valid: false, error: 'This xAI model is not on the supported chat-completions road.' }
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins xai replaces the key.` }
  if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.models.some(row => row.id.toLowerCase() === id || row.aliases?.some(alias => alias.toLowerCase() === id))) return { valid: false, error: `Model "${trimmed}" is not listed by the xAI account's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateMetaModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveMetaAccount } = await import('../meta/metaAccounts.js')
  const account = resolveMetaAccount()
  if (!account) return { valid: false, error: 'Meta is unavailable — no API key (/logins meta, or set MODEL_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('meta')
  const { getCachedMetaCatalogue, newestMetaModel } = await import('../meta/metaCatalogue.js')
  const { isMetaChatModelId } = await import('../../facts/pins/metaPins.js')
  const snapshot = getCachedMetaCatalogue()
  const id = trimmed.toLowerCase()
  if (snapshot?.lastError?.includes('refused the credential')) {
    return {
      valid: false,
      error: account.kind === 'muse-code'
        ? `${snapshot.lastError}; run /logins to sign in with Meta again.`
        : `${snapshot.lastError} — /logins meta replaces the key.`,
    }
  }
  if (id === 'muse') return newestMetaModel() ? { valid: true, skipCache: true } : { valid: false, error: "Meta's live list has not served a Standard Muse Spark model for 'muse' yet — /model refreshes it. Contributor models must be selected explicitly." }
  if (!isMetaChatModelId(id)) return { valid: false, error: 'This Meta model is not on the supported Muse Spark chat road.' }
  if (snapshot?.fetchedAtMs && !snapshot.models.some(row => row.id.toLowerCase() === id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Meta account's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateMistralModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveMistralAccount } = await import('../mistral/mistralAccounts.js')
  if (!resolveMistralAccount()) return { valid: false, error: 'Mistral is unavailable — no API key (/logins mistral, or set MISTRAL_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('mistral')
  const { getCachedMistralCatalogue, mistralListedModel, newestMistralModel } = await import('../mistral/mistralCatalogue.js')
  const { isMistralChatModelId } = await import('../../facts/pins/mistralPins.js')
  const snapshot = getCachedMistralCatalogue()
  const id = trimmed.toLowerCase()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins mistral replaces the key.` }
  if (id === 'mistral') return newestMistralModel() ? { valid: true, skipCache: true } : { valid: false, error: "Mistral's live list has not served a chat model for 'mistral' yet — /model refreshes it." }
  if (!isMistralChatModelId(id)) return { valid: false, error: 'This Mistral model is not on the chat-completions road.' }
  if (snapshot?.fetchedAtMs && !mistralListedModel(snapshot, id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Mistral account's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateZenModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveZenAccount } = await import('../zen/zenAccounts.js')
  if (!resolveZenAccount()) return { valid: false, error: 'OpenCode Zen is unavailable — no API key (/logins zen, or set OPENCODE_API_KEY).' }
  const { zenWireId } = await import('../../facts/pins/zenPins.js')
  const wire = zenWireId(trimmed)
  if (wire === '') return { valid: false, error: `'${trimmed}' names no model inside the zen/ namespace — /model lists the live Zen rows.` }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('zen')
  const { getCachedZenCatalogue, cachedLiveIds } = await import('../zen/zenCatalogue.js')
  const snapshot = getCachedZenCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins zen replaces the key.` }
  if (snapshot?.fetchedAtMs && !cachedLiveIds().has(wire.toLowerCase())) return { valid: false, error: `Model "${trimmed}" is not listed by the OpenCode Zen catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateMinimaxModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveMinimaxAccount } = await import('../minimax/minimaxAccounts.js')
  if (!resolveMinimaxAccount()) return { valid: false, error: 'MiniMax is unavailable — no API key (/logins minimax, or set MINIMAX_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('minimax')
  const { getCachedMinimaxCatalogue, minimaxListedModel, newestMinimaxModel } = await import('../minimax/minimaxCatalogue.js')
  const { isMinimaxTextModelId, minimaxDisplayPin } = await import('../../facts/pins/minimaxPins.js')
  const snapshot = getCachedMinimaxCatalogue()
  const id = trimmed.toLowerCase()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins minimax replaces the key.` }
  if (id === 'minimax') return newestMinimaxModel() ? { valid: true, skipCache: true } : { valid: false, error: "MiniMax's live list has not served a text model for 'minimax' yet — /model refreshes it." }
  if (!isMinimaxTextModelId(id)) return { valid: false, error: 'This MiniMax model is not on the text road; the video, speech, music and image lines are not supported here.' }
  if (snapshot?.models.length && !minimaxListedModel(snapshot, id)) return { valid: false, error: `Model "${trimmed}" is not listed by the MiniMax account's live catalogue.` }
  if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !minimaxDisplayPin(id)) return { valid: false, error: `Model "${trimmed}" is not listed by the MiniMax account's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateQwenModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveQwenAccount } = await import('../qwen/qwenAccounts.js')
  const qwenAccount = resolveQwenAccount()
  if (!qwenAccount) return { valid: false, error: 'Qwen is unavailable — no QwenCloud or Model Studio API key (/logins qwen, or set DASHSCOPE_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('qwen')
  const { getCachedQwenCatalogue, qwenListedModel, newestQwenModel, qwenPinScope } = await import('../qwen/qwenCatalogue.js')
  const { isQwenTextModelId, qwenDisplayPin } = await import('../../facts/pins/qwenPins.js')
  const snapshot = getCachedQwenCatalogue()
  const id = trimmed.toLowerCase()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins qwen re-binds the key.` }
  if (id === 'qwen') return newestQwenModel() ? { valid: true, skipCache: true } : { valid: false, error: "Qwen's list has not served a text model for 'qwen' yet — /model refreshes it." }
  if (!isQwenTextModelId(id)) return { valid: false, error: 'This Qwen model is not on the text road; the speech, image, video, embedding and rerank lines are not supported here.' }
  if (qwenPinScope(hostEnv(), snapshot) === 'coding-plan' || qwenDisplayPin(id)) return { valid: true, skipCache: true }
  if (snapshot?.models.length && !qwenListedModel(snapshot, id)) return { valid: false, error: `Model "${trimmed}" is not listed by the ${snapshot.endpointLabel ?? 'bound'} endpoint's live catalogue.` }
  if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0) return { valid: false, error: `Model "${trimmed}" is not listed by the ${snapshot.endpointLabel ?? 'bound'} endpoint's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateTogetherModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveTogetherAccount } = await import('../together/togetherAccounts.js')
  if (!resolveTogetherAccount()) return { valid: false, error: 'Together AI is unavailable — no API key (/logins together, or set TOGETHER_API_KEY).' }
  const { togetherDisplayPin, togetherWireId } = await import('../../facts/pins/togetherPins.js')
  const wire = togetherWireId(trimmed)
  if (wire === '') return { valid: false, error: `'${trimmed}' names no model inside the together/ namespace — /model lists the live Together AI rows.` }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('together')
  const { getCachedTogetherCatalogue, cachedLiveIds } = await import('../together/togetherCatalogue.js')
  const snapshot = getCachedTogetherCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins together replaces the key.` }
  if (snapshot?.models.length && !cachedLiveIds().has(wire.toLowerCase())) return { valid: false, error: `Model "${trimmed}" is not listed by the Together AI chat catalogue.` }
  if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !togetherDisplayPin(wire)) return { valid: false, error: `Model "${trimmed}" is not listed by the Together AI chat catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateCohereModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveCohereAccount } = await import('../cohere/cohereAccounts.js')
  if (!resolveCohereAccount()) return { valid: false, error: 'Cohere is unavailable — no API key (/logins cohere, or set COHERE_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('cohere')
  const { getCachedCohereCatalogue, cohereListedModel, newestCohereModel } = await import('../cohere/cohereCatalogue.js')
  const { cohereDisplayPin, isCohereChatModelId } = await import('../../facts/pins/coherePins.js')
  const snapshot = getCachedCohereCatalogue()
  const id = trimmed.toLowerCase()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins cohere replaces the key.` }
  if (id === 'cohere') return newestCohereModel() ? { valid: true, skipCache: true } : { valid: false, error: "Cohere's live list has not served a chat model for 'cohere' yet — /model refreshes it." }
  if (!isCohereChatModelId(id)) return { valid: false, error: 'This Cohere model is not on the chat-completions road.' }
  if (snapshot?.models.length && !cohereListedModel(snapshot, id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Cohere account's live catalogue.` }
  if (snapshot && snapshot.fetchedAtMs > 0 && snapshot.models.length === 0 && !cohereDisplayPin(id)) return { valid: false, error: `Model "${trimmed}" is not listed by the Cohere account's live catalogue.` }
  return { valid: true, skipCache: true }
}

export async function validateGroqModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveGroqAccount } = await import('../groq/groqAccounts.js')
  if (!resolveGroqAccount()) return { valid: false, error: 'Groq is unavailable — no API key (/logins groq, or set GROQ_API_KEY).' }
  const { groqWireId, isGroqTextModelId, groqDisplayPin } = await import('../../facts/pins/groqPins.js')
  const wire = groqWireId(trimmed)
  if (!isGroqTextModelId(wire)) return { valid: false, error: 'Groq requires a text model qualified as groq/<id>.' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('groq')
  const { getCachedGroqCatalogue, groqListedModel } = await import('../groq/groqCatalogue.js')
  const snapshot = getCachedGroqCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: snapshot.lastError + ' — /logins groq replaces the key.' }
  if (snapshot?.models.length ? !groqListedModel(snapshot, wire) : !groqDisplayPin(wire)) return { valid: false, error: 'Model "' + trimmed + '" is not listed by the available Groq text catalogue.' }
  return { valid: true, skipCache: true }
}

export async function validateMeliousModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveMeliousAccount } = await import('../melious/meliousAccounts.js')
  if (!resolveMeliousAccount()) return { valid: false, error: 'Melious is unavailable — no API key (/logins melious, or set MELIOUS_API_KEY).' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('melious')
  const { getCachedMeliousCatalogue, meliousListedModel } = await import('../melious/meliousCatalogue.js')
  const snapshot = getCachedMeliousCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: snapshot.lastError + ' — /logins melious replaces the key.' }
  if (snapshot && snapshot.fetchedAtMs > 0 && !snapshot.lastError && !meliousListedModel(trimmed)) return { valid: false, error: 'Model "' + trimmed + '" is not listed by the available Melious AI chat catalogue.' }
  return { valid: true, skipCache: true }
}

export async function validateCerebrasModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveCerebrasAccount } = await import('../cerebras/cerebrasAccounts.js')
  if (!resolveCerebrasAccount()) return { valid: false, error: 'Cerebras is unavailable — no API key (/logins cerebras, or set CEREBRAS_API_KEY).' }
  const { cerebrasWireId, isCerebrasTextModelId, cerebrasDisplayPin } = await import('../../facts/pins/cerebrasPins.js')
  const wire = cerebrasWireId(trimmed)
  if (!isCerebrasTextModelId(wire)) return { valid: false, error: 'Cerebras requires a text model qualified as cerebras/<id>.' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('cerebras')
  const { getCachedCerebrasCatalogue, cerebrasListedModel } = await import('../cerebras/cerebrasCatalogue.js')
  const snapshot = getCachedCerebrasCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: snapshot.lastError + ' — /logins cerebras replaces the key.' }
  if (snapshot?.models.length ? !cerebrasListedModel(snapshot, wire) : !cerebrasDisplayPin(wire)) return { valid: false, error: 'Model "' + trimmed + '" is not listed by the available Cerebras text catalogue.' }
  return { valid: true, skipCache: true }
}

export async function validateFireworksModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveFireworksAccount } = await import('../fireworks/fireworksAccounts.js')
  if (!resolveFireworksAccount()) return { valid: false, error: 'Fireworks is unavailable — no API key (/logins fireworks, or set FIREWORKS_API_KEY).' }
  const { fireworksWireId, isFireworksTextModelId, fireworksDisplayPin } = await import('../../facts/pins/fireworksPins.js')
  const wire = fireworksWireId(trimmed)
  if (!isFireworksTextModelId(wire)) return { valid: false, error: 'Fireworks requires a text model qualified as fireworks/<id>.' }
  const { readCatalogueIfPending } = await import('../catalogueOnDemand.js')
  await readCatalogueIfPending('fireworks')
  const { getCachedFireworksCatalogue, fireworksListedModel } = await import('../fireworks/fireworksCatalogue.js')
  const snapshot = getCachedFireworksCatalogue()
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: snapshot.lastError + ' — /logins fireworks replaces the key.' }
  if (snapshot?.models.length ? !fireworksListedModel(snapshot, wire) : !fireworksDisplayPin(wire)) return { valid: false, error: 'Model "' + trimmed + '" is not listed by the available Fireworks text catalogue.' }
  return { valid: true, skipCache: true }
}
