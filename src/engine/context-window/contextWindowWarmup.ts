
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'

const SOURCE_WAIT_MS = 3_000
const LOCAL_WINDOW_WAIT_MS = 10_000

interface ContextWindowSourceWait {
  timeoutMs?: number
  estTokens?: number
}

export async function contextWindowSourceReady(model: string): Promise<boolean> {
  switch (declaredRouteOf(model)) {
    case 'openrouter': {
      const { resolveOpenrouterAccount } = await import('../../models/roads/openrouter/openrouterAccounts.js')
      const { getCachedOpenrouterCatalogue } = await import('../../models/roads/openrouter/openrouterCatalogue.js')
      const account = resolveOpenrouterAccount()
      if (!account) return true
      return (getCachedOpenrouterCatalogue(account.keySource)?.models.length ?? 0) > 0
    }
    case 'gemini': {
      const { resolveGeminiAccount } = await import('../../models/roads/gemini/geminiAccounts.js')
      const { getCachedGeminiCatalogue } = await import('../../models/roads/gemini/geminiCatalogue.js')
      const account = resolveGeminiAccount()
      if (!account) return true
      return (getCachedGeminiCatalogue(account.kind)?.models.length ?? 0) > 0
    }
    case 'huggingface': {
      const { resolveHuggingfaceApiKey } = await import('../../models/roads/huggingface/huggingfaceAccounts.js')
      const { getCachedHuggingfaceCatalogue } = await import('../../models/roads/huggingface/huggingfaceCatalogue.js')
      if (!resolveHuggingfaceApiKey()) return true
      return (getCachedHuggingfaceCatalogue()?.models.length ?? 0) > 0
    }
    case 'nous': {
      const { resolveNousApiKey } = await import('../../models/roads/nous/nousAccounts.js')
      const { getCachedNousCatalogue } = await import('../../models/roads/nous/nousCatalogue.js')
      if (!resolveNousApiKey()) return true
      return (getCachedNousCatalogue()?.models.length ?? 0) > 0
    }
    case 'openai': {
      const { resolveOpenaiAccount } = await import('../../models/roads/openai/openaiAccounts.js')
      const { getCachedOpenaiCatalogue } = await import('../../models/roads/openai/openaiCatalogue.js')
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
  const { localRecordFor } = await import('../../models/roads/local/localCatalogue.js')
  const { heldLocalWindow, localPlannedWindow, localWindowApplication, localWindowHeldUnread, localWindowSettingOf } = await import('../../models/roads/local/localWindow.js')
  const record = localRecordFor(model)
  if (record === undefined) return false
  const application = localWindowApplication(record)
  if (application === 'request' || application === 'load') {
    const hold = heldLocalWindow(record)
    if (hold === undefined || hold.setting !== localWindowSettingOf(record) || localWindowHeldUnread(hold, record)) return false
  }
  return localPlannedWindow(record) !== undefined
}

async function awaitLocalWindow(model: string, estTokens: number, timeoutMs: number): Promise<boolean> {
  const { localRecordFor } = await import('../../models/roads/local/localCatalogue.js')
  const { refreshLocalDiscovery } = await import('../../models/roads/local/localDiscovery.js')
  const { decideLocalWindow, ensureLocalWindowTruth, heldLocalWindow, localPlannedWindow, localWindowApplication, localWindowHeldUnread, localWindowSettingOf } = await import('../../models/roads/local/localWindow.js')
  let record = localRecordFor(model)
  if (record === undefined) {
    await withDeadline(refreshLocalDiscovery(), timeoutMs, () => undefined, { unref: true })
    record = localRecordFor(model)
  }
  if (record === undefined) {
    await withDeadline(refreshLocalDiscovery({ force: true }), timeoutMs, () => undefined, { unref: true })
    record = localRecordFor(model)
  }
  if (record === undefined) return false
  if (record.factsUnread === true && heldLocalWindow(record) === undefined) {
    await withDeadline(refreshLocalDiscovery({ force: true, timeoutMs }), timeoutMs, () => undefined, { unref: true })
    record = localRecordFor(model) ?? record
  }
  const application = localWindowApplication(record)
  if (application === 'request' || application === 'load') {
    const setting = localWindowSettingOf(record)
    const hold = heldLocalWindow(record)
    if (hold === undefined || hold.setting !== setting || localWindowHeldUnread(hold, record)) {
      const truth = await withDeadline(ensureLocalWindowTruth(record, setting), timeoutMs, () => undefined, { unref: true })
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
        const { resolveOpenrouterAccount } = await import('../../models/roads/openrouter/openrouterAccounts.js')
        const { refreshOpenrouterCatalogue } = await import('../../models/roads/openrouter/openrouterCatalogue.js')
        const account = resolveOpenrouterAccount()
        if (account) await withDeadline(refreshOpenrouterCatalogue(account.keySource), timeoutMs, () => undefined, { unref: true })
        return true
      }
      case 'gemini': {
        const { resolveGeminiAccount } = await import('../../models/roads/gemini/geminiAccounts.js')
        const { refreshGeminiCatalogue } = await import('../../models/roads/gemini/geminiCatalogue.js')
        const account = resolveGeminiAccount()
        if (account) await withDeadline(refreshGeminiCatalogue(account.kind), timeoutMs, () => undefined, { unref: true })
        return true
      }
      case 'huggingface': {
        const { refreshHuggingfaceCatalogue } = await import('../../models/roads/huggingface/huggingfaceCatalogue.js')
        await withDeadline(refreshHuggingfaceCatalogue(), timeoutMs, () => undefined, { unref: true })
        return true
      }
      case 'nous': {
        const { refreshNousCatalogue } = await import('../../models/roads/nous/nousCatalogue.js')
        await withDeadline(refreshNousCatalogue(), timeoutMs, () => undefined, { unref: true })
        return true
      }
      case 'openai': {
        const { resolveOpenaiAccount } = await import('../../models/roads/openai/openaiAccounts.js')
        const { refreshOpenaiCatalogue } = await import('../../models/roads/openai/openaiCatalogue.js')
        const account = resolveOpenaiAccount()
        if (account) await withDeadline(refreshOpenaiCatalogue(account.kind), timeoutMs, () => undefined, { unref: true })
        return true
      }
      case 'local':
        return await awaitLocalWindow(model, wait.estTokens ?? 0, wait.timeoutMs ?? LOCAL_WINDOW_WAIT_MS)
      default:
        return true
    }
  } catch (error) {
    passedOver(error)
  }
  return declaredRouteOf(model) !== 'local'
}

export async function warmContextWindowSources(): Promise<void> {
  try {
    const { refreshLocalDiscovery } = await import('../../models/roads/local/localDiscovery.js')
    await refreshLocalDiscovery()
  } catch (error) {
    passedOver(error)
  }
}
