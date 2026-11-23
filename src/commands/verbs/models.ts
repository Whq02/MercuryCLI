import { writeSync } from 'node:fs'
import type { LiveModelsReference } from '../../integrations/resources/adapters/models.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export async function modelsCli(
  opts: { json?: boolean; boundMs?: number; env?: NodeJS.ProcessEnv } = {},
  io: { writeOut?: (text: string) => void } = {},
): Promise<LiveModelsReference> {
  await import('../../integrations/resources/registry.js')
  const { liveModelsReference, liveModelsReferenceText } = await import('../../integrations/resources/adapters/models.js')
  const out = io.writeOut ?? ((text: string) => {
    try {
      writeSync(1, text)
    } catch (error) {
      if (getErrnoCode(error) === 'EPIPE') {
        passedOver(error)
        return
      }
      throw error
    }
  })
  const reference = await liveModelsReference({ engineModel: getEngineModel() }, { boundMs: opts.boundMs, env: opts.env })
  const text = opts.json === true ? `${jsonStringify(reference, undefined, 2)}\n` : `${liveModelsReferenceText(reference)}\n`
  out(text)
  return reference
}
