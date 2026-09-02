import { appendFileSync } from 'node:fs'
import { drainScribeDispatches } from '../../../src/daemon/scribeDispatchBridge.ts'

const teamName = process.env.RELIA_TEAMNAME
const actLog = process.env.RELIA_ACT_LOG
if (!teamName || !actLog) throw new Error('RELIA_TEAMNAME + RELIA_ACT_LOG required')

const seen = new Set<string>()
const roster = {
  reply: async (_short: string, frame: string): Promise<boolean> => {
    const ids = [...frame.matchAll(/\[request_id: ([^\]]+)\]/g)]
    const replay = frame.includes('[replayed after an interruption') ? ' REPLAY' : ''
    appendFileSync(actLog, `${ids.at(-1)?.[1] ?? 'unknown'}${replay}\n`)
    if (process.env.RELIA_DIE_AFTER_ACT === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    return true
  },
}
await drainScribeDispatches(roster as never, {
  short: 'implementer',
  agentName: 'implementer',
  teamName,
  hasSeen: id => seen.has(id),
  markSeen: id => seen.add(id),
})
process.exit(0)
