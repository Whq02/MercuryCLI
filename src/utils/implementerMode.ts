import { routerEnabled } from './router/routerGates.js'
import { getLspPackEvidenceText } from '../services/lsp/mercuryLsp.js'
import { logForDebugging } from './debug.js'
import { isScribeModeOn } from './scribeMode.js'
import { buildImplementerAppend } from './scribe/implementerPack.js'
import { resolveImplementerSeat, seatDoctrineTier } from './model/seatSlots.js'
import { flagEnv } from '../substrate/flagRegistry.js'

let implementerOn = flagEnv('MERCURY_IMPLEMENTER') === '1'

export function isImplementerModeOn(): boolean {
  return implementerOn
}

export function setImplementerMode(on: boolean): void {
  implementerOn = on
}

let implementerAppendCache: { key: string; append: string } | null = null
function compileImplementerAppend(): string {
  const workflowsPosture = flagEnv('MERCURY_IMPLEMENTER_WORKFLOWS') === '1'
  const seatModel = resolveImplementerSeat().model
  const lspEvidence = getLspPackEvidenceText()
  const routed = routerEnabled()
  const cacheKey = `${workflowsPosture ? 'workflows' : 'base'}|${seatModel}|${lspEvidence ? 'lsp' : 'nolsp'}|${routed ? 'route' : 'noroute'}`
  if (implementerAppendCache?.key === cacheKey) return implementerAppendCache.append
  let append = ''
  try {
    append = buildImplementerAppend({
      workflows: workflowsPosture,
      lspEvidence,
      routed,
      executorSlot: seatDoctrineTier(seatModel) === 'executor',
    }).trim()
  } catch (err) {
    logForDebugging(`[implementer] pack build failed, appending nothing: ${String(err)}`)
    append = ''
  }
  implementerAppendCache = { key: cacheKey, append }
  return append
}

export function getImplementerModeAppend(): string {
  return compileImplementerAppend()
}

export function getImplementerModeSections(): string[] {
  if (!isImplementerModeOn() || isScribeModeOn()) return []
  const append = compileImplementerAppend()
  return append ? [append] : []
}
