// contextWindowWarmup — landing the window SOURCES before they are needed.
//
// resolveContextWindow (capabilities.ts) reads the catalogue caches
// synchronously: a carrier or engine id budgets at the labelled conservative
// default until its source lands. Two edges land them:
//   · warmContextWindowSources — boot: one TTL'd refresh per family whose
//     credential exists (the Hugging Face boot precedent, widened), so the
//     rail, /context and the compaction trigger read the stated window
//     from the first turn instead of the fallback for the whole session.
//   · awaitContextWindowSource — the compaction trigger's own edge: resolves
//     at once when the model's source is cached, else after its bounded
//     refresh (or the timeout), so a resumed transcript is never compacted
//     against the fallback window because the fetch was still in flight.
// Every refresh is the family's own single-flight, TTL'd fetch; nothing
// here invents a window, and an unreachable source still leaves the
// labelled fallback in place.

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

/** True when the source that decides `model`'s window is already cached
 *  with rows; false when a refresh could still change the answer. */
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

/** Kick the TTL'd refresh of `model`'s window source; resolves when it
 *  lands (or at once when it is already cached, or after `timeoutMs`). */
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
    // The labelled fallback stays in place; a source failure is never a
    // compaction-path failure.
  }
}

/** Boot: one TTL'd refresh per family whose credential exists — every
 *  refresh is fire-and-forget behind the family's own single-flight, and a
 *  family without a credential costs nothing. */
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
    // no OpenRouter source this boot
  }
  try {
    const { resolveGeminiAccount } = await import('../../services/providers/gemini/geminiAccounts.js')
    const account = resolveGeminiAccount()
    if (account) {
      const { refreshGeminiCatalogue } = await import('../../services/providers/gemini/geminiCatalogue.js')
      jobs.push(refreshGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key'))
    }
  } catch {
    // no Gemini source this boot
  }
  try {
    const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
    const account = resolveOpenaiAccount()
    if (account) {
      const { refreshOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
      jobs.push(refreshOpenaiCatalogue(account.kind))
    }
  } catch {
    // no OpenAI source this boot
  }
  try {
    const { resolveHuggingfaceApiKey } = await import('../../services/providers/huggingface/huggingfaceAccounts.js')
    if (resolveHuggingfaceApiKey()) {
      const { refreshHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
      jobs.push(refreshHuggingfaceCatalogue())
    }
  } catch {
    // no Hugging Face source this boot
  }
  try {
    const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
    jobs.push(refreshLocalDiscovery())
  } catch {
    // local discovery unavailable this boot
  }
  await Promise.allSettled(jobs)
}
