// FC4 prep child — write ONE dispatch envelope into a worker's inbox via
// the production write path (writeToMailbox).
import { writeToMailbox } from '../../../src/utils/teammateMailbox.ts'
import { BUS_PROTOCOL_TYPE } from '../../../src/utils/swarm/busEnvelopes.ts'

const teamName = process.env.RELIA_TEAMNAME
const requestId = process.env.RELIA_REQ
if (!teamName || !requestId) throw new Error('RELIA_TEAMNAME + RELIA_REQ required')
const timestamp = new Date().toISOString()
const envelope = {
  type: BUS_PROTOCOL_TYPE,
  kind: 'dispatch',
  request_id: requestId,
  from: 'team-lead',
  timestamp,
  task: 'apply the one-line fix and report back',
}
const okWrite = await writeToMailbox(
  'worker',
  { from: 'team-lead', text: JSON.stringify(envelope), timestamp },
  teamName,
)
process.exit(okWrite ? 0 : 1)
