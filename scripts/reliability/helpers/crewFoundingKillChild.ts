import { writeFileSync } from 'node:fs'
import { getSessionId } from '../../../src/bootstrap/state.ts'
import { sessionCrewName } from '../../../src/utils/crew/crewBirth.ts'
import { appendCrewMember } from '../../../src/utils/swarm/crewHelpers.ts'

const out = process.env.RELIA_OUT
if (!out) throw new Error('RELIA_OUT required')
const crew = sessionCrewName(String(getSessionId()))
writeFileSync(out, `${crew}\n`)
await appendCrewMember(crew, {
  agentId: `alpha@${crew}`,
  name: 'alpha',
  joinedAt: Date.now(),
  tmuxPaneId: 'in-process',
  cwd: process.cwd(),
  subscriptions: [],
})
process.exit(0)
