// FC4 child — one daemon lifetime of the production drain (drainDispatches)
// with the daemon's real dedup shape: an IN-MEMORY seen-set
// (roster.seenDispatchIds is process memory). The roster's reply is the
// ACT: it appends the delivered request_id to RELIA_ACT_LOG. With
// RELIA_DIE_AFTER_ACT=1 the process SIGKILLs itself inside reply — acted,
// died before the drain's mark-read acknowledgement. A second lifetime (fresh
// process, fresh seen-set) shows whether the acted work replays.
import { appendFileSync } from 'node:fs'
import { drainDispatches } from '../../../src/daemon/dispatchDrain.ts'

const teamName = process.env.RELIA_TEAMNAME
const actLog = process.env.RELIA_ACT_LOG
if (!teamName || !actLog) throw new Error('RELIA_TEAMNAME + RELIA_ACT_LOG required')

const seen = new Set<string>() // the daemon's in-memory seenDispatchIds shape
const roster = {
  reply: async (_short: string, frame: string): Promise<boolean> => {
    // The dispatch's real id is the TRAILER at the end of the frame — the
    // report-back framing text itself contains a literal `[request_id: …]`
    // example, so take the LAST occurrence, never the first.
    const ids = [...frame.matchAll(/\[request_id: ([^\]]+)\]/g)]
    const replay = frame.includes('[replayed after an interruption') ? ' REPLAY' : ''
    appendFileSync(actLog, `${ids.at(-1)?.[1] ?? 'unknown'}${replay}\n`)
    if (process.env.RELIA_DIE_AFTER_ACT === '1') {
      process.kill(process.pid, 'SIGKILL') // died after acting, before the ack
    }
    return true
  },
}
await drainDispatches(roster as never, {
  short: 'worker',
  agentName: 'worker',
  teamName,
  hasSeen: id => seen.has(id),
  markSeen: id => seen.add(id),
})
process.exit(0)
