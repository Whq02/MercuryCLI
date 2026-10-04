import { appendFileSync } from 'node:fs'
import { drainDispatches } from '../../../src/daemon/dispatchDrain.ts'
import type { InputRow } from '../../../src/rows/vocabulary.ts'

const crewName = process.env.RELIA_CREWNAME
const actLog = process.env.RELIA_ACT_LOG
if (!crewName || !actLog) throw new Error('RELIA_CREWNAME + RELIA_ACT_LOG required')

const seen = new Set<string>()
const roster = {
  reply: async (_short: string, row: InputRow): Promise<boolean> => {
    const frame = row.type === 'prompt' && typeof row.content === 'string' ? row.content : ''
    const ids = [...frame.matchAll(/\[request_id: ([^\]]+)\]/g)]
    const replay = frame.includes('[replayed after an interruption') ? ' REPLAY' : ''
    appendFileSync(actLog, `${ids.at(-1)?.[1] ?? 'unknown'}${replay}\n`)
    if (process.env.RELIA_DIE_AFTER_ACT === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    return true
  },
}
await drainDispatches(roster as never, {
  short: 'worker',
  agentName: 'worker',
  crewName,
  hasSeen: id => seen.has(id),
  markSeen: id => seen.add(id),
})
process.exit(0)
