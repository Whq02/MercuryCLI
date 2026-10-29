import { declaredRouteOf } from '../../services/providers/routeLaw.js'

const SOURCE_WAIT_MS = 3_000
const LOCAL_WINDOW_WAIT_MS = 10_000

interface ContextWindowSourceWait {
  timeoutMs?: number
  estTokens?: number
}

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
      return (getCachedGeminiCatalogue(account.kind)?.models.length ?? 0) > 0
    }
    case 'huggingface': {
      const { resolveHuggingfaceApiKey } = await import('../../services/providers/huggingface/huggingfaceAccounts.js')
      const { getCachedHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
      if (!resolveHuggingfaceApiKey()) return true
      return (getCachedHuggingfaceCatalogue()?.models.length ?? 0) > 0
    }
    case 'nous': {
      const { resolveNousApiKey } = await import('../../services/providers/nous/nousAccounts.js')
      const { getCachedNousCatalogue } = await import('../../services/providers/nous/nousCatalogue.js')
      if (!resolveNousApiKey()) return true
      return (getCachedNousCatalogue()?.models.length ?? 0) > 0
    }
    case 'openai': {
      const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
      const { getCachedOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
      const account = resolveOpenaiAccount()
      if (!account) return true
      return (getCachedOpenaiCatalogue(account.kind)?.models.length ?? 0) > 0
    }
    case 'local':
      return localWindowKnown(model)
    default:
      return true
  }
}

async function localWindowKnown(model: string): Promise<boolean> {
  const { localRecordFor } = await import('../../services/providers/local/localCatalogue.js')
  const { heldLocalWindow, localPlannedWindow, localWindowApplication, localWindowSettingOf } = await import('../../services/providers/local/localWindow.js')
  const record = localRecordFor(model)
  if (record === undefined) return false
  const application = localWindowApplication(record)
  if (application === 'request' || application === 'load') {
    const hold = heldLocalWindow(record)
    if (hold === undefined || hold.setting !== localWindowSettingOf(record)) return false
  }
  return localPlannedWindow(record) !== undefined
}

async function awaitLocalWindow(model: string, estTokens: number, timeoutMs: number): Promise<boolean> {
  const { localRecordFor } = await import('../../services/providers/local/localCatalogue.js')
  const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
  const { decideLocalWindow, ensureLocalWindowTruth, heldLocalWindow, localPlannedWindow, localWindowApplication, localWindowSettingOf } = await import('../../services/providers/local/localWindow.js')
  let record = localRecordFor(model)
  if (record === undefined) {
    await withTimeout(refreshLocalDiscovery(), timeoutMs)
    record = localRecordFor(model)
  }
  if (record === undefined) {
    await withTimeout(refreshLocalDiscovery({ force: true }), timeoutMs)
    record = localRecordFor(model)
  }
  if (record === undefined) return false
  const application = localWindowApplication(record)
  if (application === 'request' || application === 'load') {
    const setting = localWindowSettingOf(record)
    const hold = heldLocalWindow(record)
    if (hold === undefined || hold.setting !== setting) {
      const truth = await withTimeout(ensureLocalWindowTruth(record, setting), timeoutMs)
      if (truth === undefined) return false
      decideLocalWindow(record, estTokens, setting, truth)
    }
  }
  return localPlannedWindow(record) !== undefined
}

export async function awaitContextWindowSource(model: string, wait: ContextWindowSourceWait = {}): Promise<boolean> {
  const timeoutMs = wait.timeoutMs ?? SOURCE_WAIT_MS
  try {
    if (await contextWindowSourceReady(model)) return true
    switch (declaredRouteOf(model)) {
      case 'openrouter': {
        const { resolveOpenrouterAccount } = await import('../../services/providers/openrouter/openrouterAccounts.js')
        const { refreshOpenrouterCatalogue } = await import('../../services/providers/openrouter/openrouterCatalogue.js')
        const account = resolveOpenrouterAccount()
        if (account) await withTimeout(refreshOpenrouterCatalogue(account.keySource), timeoutMs)
        return true
      }
      case 'gemini': {
        const { resolveGeminiAccount } = await import('../../services/providers/gemini/geminiAccounts.js')
        const { refreshGeminiCatalogue } = await import('../../services/providers/gemini/geminiCatalogue.js')
        const account = resolveGeminiAccount()
        if (account) await withTimeout(refreshGeminiCatalogue(account.kind), timeoutMs)
        return true
      }
      case 'huggingface': {
        const { refreshHuggingfaceCatalogue } = await import('../../services/providers/huggingface/huggingfaceCatalogue.js')
        await withTimeout(refreshHuggingfaceCatalogue(), timeoutMs)
        return true
      }
      case 'nous': {
        const { refreshNousCatalogue } = await import('../../services/providers/nous/nousCatalogue.js')
        await withTimeout(refreshNousCatalogue(), timeoutMs)
        return true
      }
      case 'openai': {
        const { resolveOpenaiAccount } = await import('../../services/providers/openai/openaiAccounts.js')
        const { refreshOpenaiCatalogue } = await import('../../services/providers/openai/openaiCatalogue.js')
        const account = resolveOpenaiAccount()
        if (account) await withTimeout(refreshOpenaiCatalogue(account.kind), timeoutMs)
        return true
      }
      case 'local':
        return await awaitLocalWindow(model, wait.estTokens ?? 0, wait.timeoutMs ?? LOCAL_WINDOW_WAIT_MS)
      default:
        return true
    }
  } catch {
  }
  return declaredRouteOf(model) !== 'local'
}

export async function warmContextWindowSources(): Promise<void> {
  try {
    const { refreshLocalDiscovery } = await import('../../services/providers/local/localDiscovery.js')
    await refreshLocalDiscovery()
  } catch {
  }
}
