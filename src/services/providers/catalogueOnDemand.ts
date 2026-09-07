import { catalogueTrafficVerdict } from './catalogueGate.js'

export const KEYED_CATALOGUE_FAMILIES = ['openai', 'openrouter', 'gemini', 'huggingface'] as const
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

export async function readCatalogueIfPending(family: string, opts?: { boundMs?: number }): Promise<boolean> {
  const boundMs = opts?.boundMs ?? CATALOGUE_READ_BOUND_MS
  try {
    switch (family) {
      case 'openai': {
        const { readOpenaiCatalogueIfPending } = await import('./openai/openaiCatalogue.js')
        return await readOpenaiCatalogueIfPending({ boundMs })
      }
      case 'openrouter': {
        const [{ getCachedOpenrouterCatalogue, refreshOpenrouterCatalogue }, { resolveOpenrouterRequestAuth }] =
          await Promise.all([import('./openrouter/openrouterCatalogue.js'), import('./openrouter/openrouterAccounts.js')])
        const auth = resolveOpenrouterRequestAuth(process.env)
        if (!auth || !catalogueTrafficVerdict('openrouter').allowed) return false
        if (!nothingUsable(getCachedOpenrouterCatalogue(auth.account.keySource))) return false
        await bounded(refreshOpenrouterCatalogue(auth.account.keySource), boundMs)
        return true
      }
      case 'gemini': {
        const [{ getCachedGeminiCatalogue, refreshGeminiCatalogue }, { resolveGeminiAccount }] =
          await Promise.all([import('./gemini/geminiCatalogue.js'), import('./gemini/geminiAccounts.js')])
        const account = resolveGeminiAccount(process.env)
        if (!account || !catalogueTrafficVerdict('gemini').allowed) return false
        const sourceKind = account.kind === 'oauth' ? 'oauth' : 'api-key'
        if (!nothingUsable(getCachedGeminiCatalogue(sourceKind))) return false
        await bounded(refreshGeminiCatalogue(sourceKind), boundMs)
        return true
      }
      case 'huggingface': {
        const [{ getCachedHuggingfaceCatalogue, refreshHuggingfaceCatalogue }, { resolveHuggingfaceAccount }] =
          await Promise.all([import('./huggingface/huggingfaceCatalogue.js'), import('./huggingface/huggingfaceAccounts.js')])
        if (!resolveHuggingfaceAccount(process.env) || !catalogueTrafficVerdict('huggingface').allowed) return false
        if (!nothingUsable(getCachedHuggingfaceCatalogue())) return false
        await bounded(refreshHuggingfaceCatalogue(), boundMs)
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
