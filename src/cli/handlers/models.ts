import { writeSync } from 'node:fs'
import type { LiveModelsReference } from '../../services/resources/adapters/models.js'
import { getEngineModel } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'

export async function modelsCli(
  opts: { json?: boolean; boundMs?: number; env?: NodeJS.ProcessEnv } = {},
  io: { writeOut?: (text: string) => void } = {},
): Promise<LiveModelsReference> {
  await import('../../services/resources/registry.js')
  const { liveModelsReference, liveModelsReferenceText } = await import('../../services/resources/adapters/models.js')
  const out = io.writeOut ?? ((text: string) => { try { writeSync(1, text) } catch {} })
  const reference = await liveModelsReference({ engineModel: getEngineModel() }, { boundMs: opts.boundMs, env: opts.env })
  const text = opts.json === true ? `${jsonStringify(reference, undefined, 2)}\n` : `${liveModelsReferenceText(reference)}\n`
  out(text)
  return reference
}
