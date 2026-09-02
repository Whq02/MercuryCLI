import type { LocalCommandCall } from '../../types/command.js'
import { haltAll, summarizeHalt } from '../../utils/haltAll.js'

export const call: LocalCommandCall = async (_args, context) => {
  const result = await haltAll(context as Parameters<typeof haltAll>[0])
  return { type: 'text', value: `⊘ Hard stop — ${summarizeHalt(result)}.` }
}
