
import { declaredRouteOf } from '../../services/providers/routeLaw.js'

const SOURCE_WAIT_MS = 3_000

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function contextWindowSourceReady(model: string): Promise<boolean> {
  switch (declaredRouteOf(model)) {
    case 'openrouter': {
      const { resolveOpenrouterAccount } = await import('../../services/providers/openrouter/openrouterAccounts.js')
      const { getCachedOpenrouterCatalogue } = await import('../../services/providers/openrouter/openrouterCatalogue.js')
      const account = resolveOpenrouterAccount()
      if (!account) return true
      return (getCachedOpenrouterCatalogue(account.keySource)?.models.length ?? 0) > 0
    }
    case 'gemini': {
      const { resolveGeminiAccount } = await import('../../services/providers/gemini/geminiAccounts.js')
      const { getCachedGeminiCatalogue } = await import('../../services/providers/gemini/geminiCatalogue.js')
      const account = resolveGeminiAccount()
      if (!account) return true
      return (getCachedGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key')?.models.length ?? 0) > 0
    }
    case 'huggingface': {
      const { resolveHuggingfaceApiKey } = await import('../../services/providers/huggingface/huggingfaceAccounts.js')
      const { getCachedHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
      if (!resolveHuggingfaceApiKey()) return true
      return (getCachedHuggingfaceCatalogue()?.models.length ?? 0) > 0
    }
    case 'openai': {
      const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
      const { getCachedOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
      const account = resolveOpenaiAccount()
      if (!account) return true
      return (getCachedOpenaiCatalogue(account.kind)?.models.length ?? 0) > 0
    }
    case 'local': {
      const { getCachedLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
      return getCachedLocalDiscovery() !== null
    }
    default:
      return true
  }
}

export async function awaitContextWindowSource(model: string, timeoutMs = SOURCE_WAIT_MS): Promise<void> {
  try {
    if (await contextWindowSourceReady(model)) return
    switch (declaredRouteOf(model)) {
      case 'openrouter': {
        const { resolveOpenrouterAccount } = await import('../../services/providers/openrouter/openrouterAccounts.js')
        const { refreshOpenrouterCatalogue } = await import('../../services/providers/openrouter/openrouterCatalogue.js')
        const account = resolveOpenrouterAccount()
        if (account) await withTimeout(refreshOpenrouterCatalogue(account.keySource), timeoutMs)
        return
      }
      case 'gemini': {
        const { resolveGeminiAccount } = await import('../../services/providers/gemini/geminiAccounts.js')
        const { refreshGeminiCatalogue } = await import('../../services/providers/gemini/geminiCatalogue.js')
        const account = resolveGeminiAccount()
        if (account) await withTimeout(refreshGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key'), timeoutMs)
        return
      }
      case 'huggingface': {
        const { refreshHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
        await withTimeout(refreshHuggingfaceCatalogue(), timeoutMs)
        return
      }
      case 'openai': {
        const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
        const { refreshOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
        const account = resolveOpenaiAccount()
        if (account) await withTimeout(refreshOpenaiCatalogue(account.kind), timeoutMs)
        return
      }
      case 'local': {
        const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
        await withTimeout(refreshLocalDiscovery(), timeoutMs)
        return
      }
      default:
        return
    }
  } catch {
  }
}

export async function warmContextWindowSources(): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  try {
    const { resolveOpenrouterAccount } = await import('../../services/providers/openrouter/openrouterAccounts.js')
    const account = resolveOpenrouterAccount()
    if (account) {
      const { refreshOpenrouterCatalogue } = await import('../../services/providers/openrouter/openrouterCatalogue.js')
      jobs.push(refreshOpenrouterCatalogue(account.keySource))
    }
  } catch {
  }
  try {
    const { resolveGeminiAccount } = await import('../../services/providers/gemini/geminiAccounts.js')
    const account = resolveGeminiAccount()
    if (account) {
      const { refreshGeminiCatalogue } = await import('../../services/providers/gemini/geminiCatalogue.js')
      jobs.push(refreshGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key'))
    }
  } catch {
  }
  try {
    const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
    const account = resolveOpenaiAccount()
    if (account) {
      const { refreshOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
      jobs.push(refreshOpenaiCatalogue(account.kind))
    }
  } catch {
  }
  try {
    const { resolveHuggingfaceApiKey } = await import('../../services/providers/huggingface/huggingfaceAccounts.js')
    if (resolveHuggingfaceApiKey()) {
      const { refreshHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
      jobs.push(refreshHuggingfaceCatalogue())
    }
  } catch {
  }
  try {
    const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
    jobs.push(refreshLocalDiscovery())
  } catch {
  }
  await Promise.allSettled(jobs)
}
