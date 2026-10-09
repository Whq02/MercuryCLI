import { catalogueTrafficVerdict } from './catalogueGate.js'

export const KEYED_CATALOGUE_FAMILIES = ['openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'xai', 'meta', 'zai', 'mistral', 'nous'] as const
export type KeyedCatalogueFamily = (typeof KEYED_CATALOGUE_FAMILIES)[number]

export const CATALOGUE_READ_BOUND_MS = 5_000

export function isKeyedCatalogueFamily(family: string): family is KeyedCatalogueFamily {
  return (KEYED_CATALOGUE_FAMILIES as readonly string[]).includes(family)
}

async function bounded(refresh: Promise<unknown>, boundMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    refresh.catch(() => null),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, boundMs)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
}

function nothingUsable(snapshot: { models: readonly unknown[]; lastError?: string } | null): boolean {
  return snapshot === null || (snapshot.models.length === 0 && snapshot.lastError !== undefined)
}

export async function readCatalogueIfPending(family: string, opts?: { boundMs?: number; force?: boolean }): Promise<boolean> {
  const boundMs = opts?.boundMs ?? CATALOGUE_READ_BOUND_MS
  const force = opts?.force === true
  try {
    switch (family) {
      case 'openai': {
        const { readOpenaiCatalogueIfPending } = await import('./openai/openaiCatalogue.js')
        return await readOpenaiCatalogueIfPending({ boundMs, force })
      }
      case 'openrouter': {
        const [{ getCachedOpenrouterCatalogue, refreshOpenrouterCatalogue }, { resolveOpenrouterRequestAuth }] =
          await Promise.all([import('./openrouter/openrouterCatalogue.js'), import('./openrouter/openrouterAccounts.js')])
        const auth = resolveOpenrouterRequestAuth(process.env)
        if (!auth || !catalogueTrafficVerdict('openrouter').allowed) return false
        if (!nothingUsable(getCachedOpenrouterCatalogue(auth.account.keySource))) return false
        await bounded(refreshOpenrouterCatalogue(auth.account.keySource, { force }), boundMs)
        return true
      }
      case 'gemini': {
        const [{ getCachedGeminiCatalogue, refreshGeminiCatalogue }, { resolveGeminiAccount }] =
          await Promise.all([import('./gemini/geminiCatalogue.js'), import('./gemini/geminiAccounts.js')])
        const account = resolveGeminiAccount(process.env)
        if (!account || !catalogueTrafficVerdict('gemini').allowed) return false
        const sourceKind = account.kind === 'oauth' ? 'oauth' : 'api-key'
        if (!nothingUsable(getCachedGeminiCatalogue(sourceKind))) return false
        await bounded(refreshGeminiCatalogue(sourceKind, { force }), boundMs)
        return true
      }
      case 'xai': {
        const { getCachedXaiCatalogue, refreshXaiCatalogue } = await import('./xai/xaiCatalogue.js')
        if (!catalogueTrafficVerdict('xai').allowed) return false
        if (!force && !nothingUsable(getCachedXaiCatalogue())) return false
        await bounded(refreshXaiCatalogue({ force }), boundMs)
        return true
      }
      case 'meta': {
        const { getCachedMetaCatalogue, refreshMetaCatalogue } = await import('./meta/metaCatalogue.js')
        if (!catalogueTrafficVerdict('meta').allowed) return false
        if (!force && !nothingUsable(getCachedMetaCatalogue())) return false
        await bounded(refreshMetaCatalogue({ force }), boundMs)
        return true
      }
      case 'moonshot': {
        const { getCachedMoonshotCatalogue, refreshMoonshotCatalogue } = await import('./moonshot/moonshotCatalogue.js')
        if (!catalogueTrafficVerdict('moonshot').allowed) return false
        if (!nothingUsable(getCachedMoonshotCatalogue())) return false
        await bounded(refreshMoonshotCatalogue({ force }), boundMs)
        return true
      }
      case 'huggingface': {
        const [{ getCachedHuggingfaceCatalogue, refreshHuggingfaceCatalogue }, { resolveHuggingfaceAccount }] =
          await Promise.all([import('./huggingface/huggingfaceCatalogue.js'), import('./huggingface/huggingfaceAccounts.js')])
        if (!resolveHuggingfaceAccount(process.env) || !catalogueTrafficVerdict('huggingface').allowed) return false
        if (!nothingUsable(getCachedHuggingfaceCatalogue())) return false
        await bounded(refreshHuggingfaceCatalogue({ force }), boundMs)
        return true
      }
      case 'zai': {
        const { getCachedZaiCatalogue, refreshZaiCatalogue } = await import('./zai/zaiCatalogue.js')
        if (!catalogueTrafficVerdict('zai').allowed) return false
        if (!force && !nothingUsable(getCachedZaiCatalogue())) return false
        await bounded(refreshZaiCatalogue({ force }), boundMs)
        return true
      }
      case 'mistral': {
        const { getCachedMistralCatalogue, refreshMistralCatalogue } = await import('./mistral/mistralCatalogue.js')
        if (!catalogueTrafficVerdict('mistral').allowed) return false
        if (!force && !nothingUsable(getCachedMistralCatalogue())) return false
        await bounded(refreshMistralCatalogue({ force }), boundMs)
        return true
      }
      case 'nous': {
        const { getCachedNousCatalogue, refreshNousCatalogue } = await import('./nous/nousCatalogue.js')
        if (!catalogueTrafficVerdict('nous').allowed) return false
        if (!force && !nothingUsable(getCachedNousCatalogue())) return false
        await bounded(refreshNousCatalogue({ force }), boundMs)
        return true
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

export async function readCataloguesForOtherFamilies(home: string | null, opts?: { boundMs?: number }): Promise<KeyedCatalogueFamily[]> {
  const outcomes = await Promise.all(
    KEYED_CATALOGUE_FAMILIES.filter(family => family !== home).map(async family => ((await readCatalogueIfPending(family, opts)) ? family : null)),
  )
  return outcomes.filter((family): family is KeyedCatalogueFamily => family !== null)
}
