import type { LocalCommandCall } from '../../types/command.js'
import { haltAll, summarizeHalt } from '../../utils/haltAll.js'

// /halt — the operator's hard-stop / manual break (#35). Kills every in-process
// running agent AND the scheduler daemon + the workers it hosts (the Implementer +
// any rostered/fleet workers) in one gesture. Never throws; reports what it stopped.
export const call: LocalCommandCall = async (_args, context) => {
  const result = await haltAll(context as Parameters<typeof haltAll>[0])
  return { type: 'text', value: `⊘ Hard stop — ${summarizeHalt(result)}.` }
}
