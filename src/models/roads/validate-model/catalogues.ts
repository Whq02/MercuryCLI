import type { ValidateModelResult } from './result.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

export async function validateHuggingfaceModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveHuggingfaceApiKey } = await import(
    '../huggingface/huggingfaceAccounts.js'
  )
  if (!resolveHuggingfaceApiKey()) {
    return {
      valid: false,
      error: 'Hugging Face is unavailable — no credential (/logins connects, or set HF_TOKEN).',
    }
  }
  const { huggingfaceLiveModel, getCachedHuggingfaceCatalogue, refreshHuggingfaceCatalogue } = await import(
    '../huggingface/huggingfaceCatalogue.js'
  )
  await refreshHuggingfaceCatalogue().catch(passedOverAs(null))
  const snapshot = getCachedHuggingfaceCatalogue()
  if (!snapshot || snapshot.models.length === 0) return { valid: true, skipCache: true }
  const { qualifiedWireId } = await import('../routeLaw.js')
  if (!huggingfaceLiveModel(qualifiedWireId(trimmed))) {
    return {
      valid: false,
      error: `Model "${trimmed}" is not listed by the Hugging Face router catalogue (${snapshot.models.length} live models; huggingface/<org>/<model>).`,
    }
  }
  return { valid: true }
}

export async function validateLocalModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { localRecordFor } = await import('../local/localCatalogue.js')
  const { refreshLocalDiscovery } = await import('../local/localDiscovery.js')
  if (!localRecordFor(trimmed)) await refreshLocalDiscovery({ force: true }).catch(passedOverAs(null))
  if (!localRecordFor(trimmed)) {
    return {
      valid: false,
      error: `No local server lists "${trimmed}" — start Ollama/LM Studio/vLLM/llama.cpp-server or set MERCURY_LOCAL_BASE_URL; /model re-probes on open.`,
    }
  }
  return { valid: true, skipCache: true }
}

export async function validateNousModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveNousAccount } = await import('../nous/nousAccounts.js')
  if (!resolveNousAccount()) {
    return { valid: false, error: 'Nous Portal is unavailable — no API key (/logins nous stores one, or set NOUS_API_KEY).' }
  }
  const { refreshNousCatalogue, nousWireModelId } = await import('../nous/nousCatalogue.js')
  const snapshot = await refreshNousCatalogue().catch(passedOverAs(null))
  if (snapshot?.lastError?.includes('refused the credential')) return { valid: false, error: `${snapshot.lastError} — /logins nous stores another key.` }
  if (snapshot && snapshot.models.length > 0) {
    const { qualifiedWireId } = await import('../routeLaw.js')
    const slug = qualifiedWireId(trimmed)
    const listed = snapshot.models.some(m => m.id.toLowerCase() === slug.trim().toLowerCase())
    if (!listed) {
      const healed = nousWireModelId(trimmed)
      const hint = healed.toLowerCase() !== slug.trim().toLowerCase() ? ` Did you mean "nous/${healed}"?` : ''
      return { valid: false, error: `Model "${trimmed}" is not listed by the live Nous Portal catalogue (${snapshot.models.length} models; nous/<vendor>/<model>).${hint}` }
    }
  }
  return { valid: true, skipCache: true }
}

export async function validateOpenrouterModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveOpenrouterAccount } = await import(
    '../openrouter/openrouterAccounts.js'
  )
  const account = resolveOpenrouterAccount()
  if (!account) {
    return {
      valid: false,
      error: 'OpenRouter is unavailable — no account (/logins adds OpenRouter: OAuth mints a key, or paste one).',
    }
  }
  const { refreshOpenrouterCatalogue } = await import(
    '../openrouter/openrouterCatalogue.js'
  )
  const snapshot = await refreshOpenrouterCatalogue(account.keySource).catch(passedOverAs(null))
  if (snapshot && snapshot.models.length > 0) {
    const { qualifiedWireId } = await import('../routeLaw.js')
    const { openrouterWireModelId } = await import(
      '../openrouter/openrouterCallModel.js'
    )
    const slug = qualifiedWireId(trimmed)
    const listed = snapshot.models.some(m => m.id.toLowerCase() === slug.trim().toLowerCase())
    if (!listed) {
      const healed = openrouterWireModelId(trimmed)
      const hint =
        healed.toLowerCase() !== slug.trim().toLowerCase()
          ? ` Did you mean "openrouter/${healed}"?`
          : ''
      return {
        valid: false,
        error: `Model "${trimmed}" is not listed by the live OpenRouter catalogue (${snapshot.models.length} models; openrouter/<vendor>/<model>).${hint}`,
      }
    }
  }
  return { valid: true, skipCache: true }
}

export async function validateMoonshotModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { moonshotDispatchSource } = await import(
    '../moonshot/moonshotAccounts.js'
  )
  if (moonshotDispatchSource() === undefined) {
    return {
      valid: false,
      error: 'Moonshot is unavailable — no Kimi sign-in or API key (/logins moonshot, or set MOONSHOT_API_KEY).',
    }
  }
  const { qualifyMoonshotModel } = await import('../moonshot/moonshotCatalogue.js')
  const verdict = await qualifyMoonshotModel(trimmed.toLowerCase())
  return verdict.kind === 'refused' ? { valid: false, error: verdict.message } : { valid: true, skipCache: true }
}

export async function validateOpenaiModel(trimmed: string): Promise<ValidateModelResult & { skipCache?: boolean }> {
  const { resolveOpenaiAccount } = await import(
    '../openai/openaiAccounts.js'
  )
  const account = resolveOpenaiAccount()
  if (!account) {
    return {
      valid: false,
      error: 'No OpenAI account — /logins signs in a ChatGPT subscription, or set OPENAI_API_KEY.',
    }
  }
  const { evaluateGptCandidate, qualifiedGptCandidates, refreshOpenaiCatalogue } = await import(
    '../openai/openaiCatalogue.js'
  )
  const { modelNotOfferedByCatalogue } = await import('../catalogueAdmission.js')
  await refreshOpenaiCatalogue(account.kind).catch(passedOverAs(null))
  const evaluated = evaluateGptCandidate(trimmed.toLowerCase(), account.kind)
  if (evaluated.ok) return { valid: true }
  switch (evaluated.why.reason) {
    case 'catalogue-unavailable':
      return { valid: true, skipCache: true }
    case 'not-in-live-catalogue':
      return {
        valid: false,
        error: modelNotOfferedByCatalogue(trimmed, account.label, qualifiedGptCandidates('specialist', account.kind).map(candidate => candidate.identity.canonicalId)),
      }
    case 'hidden-or-retired':
      return {
        valid: false,
        error: `Model "${trimmed}" is hidden/retired in the live catalogue (${evaluated.why.detail}).`,
      }
    default:
      return {
        valid: false,
        error: `Model "${trimmed}" is not accepted by the live GPT catalogue (${evaluated.why.reason}).`,
      }
  }
}
