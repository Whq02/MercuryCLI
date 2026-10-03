import { sendLiveMessage } from '../../../src/services/crew/liveComms.ts'
import { BUS_PROTOCOL_TYPE } from '../../../src/utils/crew/busEnvelopes.ts'

const crewName = process.env.RELIA_CREWNAME
const requestId = process.env.RELIA_REQ
if (!crewName || !requestId) throw new Error('RELIA_CREWNAME + RELIA_REQ required')
const timestamp = new Date().toISOString()
const envelope = {
  type: BUS_PROTOCOL_TYPE,
  kind: 'dispatch',
  request_id: requestId,
  from: 'crew-lead',
  timestamp,
  task: 'apply the one-line fix and report back',
}
const okWrite = await sendLiveMessage(crewName, { to: 'worker', from: 'crew-lead', text: JSON.stringify(envelope), timestamp })
process.exit(okWrite ? 0 : 1)
