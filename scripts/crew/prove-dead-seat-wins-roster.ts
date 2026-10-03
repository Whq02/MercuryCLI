#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dead-seat-roster-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const th = await import('../../src/utils/crew/crewHelpers.ts')
const { getAgentStatuses } = await import('../../src/utils/tasks.ts')

const CREW = 'dead-seat'
const LEAD_ID = 'crew-lead@dead-seat'
const SEAT = 'ghost'
const SEAT_ID = `${SEAT}@${CREW}`
const SLEEP = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }

const member = (name: string, agentId: string, role: string) => ({ agentId, name, role, joinedAt: Date.now(), tmuxPaneId: '', cwd: scratch, subscriptions: [] as string[] })
async function freshCrew(): Promise<void> {
  await th.writeCrewFileAsync(CREW, {
    name: CREW,
    description: 'a seat that fails at its spawn',
    createdAt: Date.now(),
    leadAgentId: LEAD_ID,
    members: [member('crew-lead', LEAD_ID, 'lead'), { ...member(SEAT, SEAT_ID, 'crewmate'), agentType: 'mercury-crew', backendType: 'in-process' }],
  })
}
const rosterNames = async (): Promise<string[]> => ((await th.readCrewFileAsync(CREW))?.members ?? []).map(m => `${m.name}${m.isActive === undefined ? '' : `:${m.isActive ? 'live' : 'off'}`}`)
const crewPath = th.getCrewFilePath(CREW)
const lockDir = `${crewPath}.lock`
const publishing = (): string | undefined => readdirSync(dirname(crewPath)).find(name => name.startsWith(`.${basename(crewPath)}.`) && name.endsWith('.tmp'))
const untilPublishing = async (ms: number): Promise<string | undefined> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const tmp = publishing()
    if (tmp !== undefined && existsSync(lockDir)) return tmp
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return publishing()
}
const ATTEMPTS = 6

console.log('============================================================')
console.log(' A seat that failed is not a live member: its removal wins over the live flag its own turn wrote')
console.log('============================================================')

section('the seam: the runner writes the live flag through the roster lane and removes a failed seat by the same lane')
{
  const helpers = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'crew', 'crewHelpers.ts'), 'utf8')
  const removalAt = helpers.indexOf('export async function removeMemberByAgentId(')
  const removalBody = removalAt === -1 ? '' : helpers.slice(removalAt, helpers.indexOf('\n}\n', removalAt))
  check('removeMemberByAgentId is the lane\'s (async, serialised behind the flag writes), never the sync lock whose backoff spins the event loop the lane needs', removalAt !== -1 && removalBody.includes('withLockedCrewFile(') && !removalBody.includes('withLockedCrewFileSync('), removalAt === -1 ? 'no async removeMemberByAgentId' : removalBody.split('\n')[1] ?? '')
  const runner = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'crew', 'inProcessRunner.ts'), 'utf8')
  const failedAt = runner.indexOf("if (wasRunning && status === 'failed') {")
  const failedBlock = failedAt === -1 ? '' : runner.slice(failedAt, failedAt + 400)
  check('the failed terminalisation removes the member through that road and keeps the refusal of a rejected write on the debug log', failedAt !== -1 && failedBlock.includes('removeMemberByAgentId(identity.crewName, identity.agentId)') && failedBlock.includes('.catch('), failedBlock.split('\n').slice(0, 3).join(' | '))
}

section('the interleaving: the removal lands while the lane holds the roster for the live flag the turn start wrote')
{
  const caught: number[] = []
  const cameBack: string[] = []
  const notRemoved: number[] = []
  const listed: string[] = []
  let leadLost = false
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await freshCrew()
    const flagInFlight = th.setMemberActive(CREW, SEAT, true)
    const tmp = await untilPublishing(5_000)
    if (tmp !== undefined) caught.push(attempt)
    const removed = await Promise.resolve(th.removeMemberByAgentId(CREW, SEAT_ID))
    await flagInFlight
    await SLEEP(50)
    const after = await rosterNames()
    if (removed !== true) notRemoved.push(attempt)
    if (after.some(name => name === SEAT || name.startsWith(`${SEAT}:`))) cameBack.push(`#${attempt} ${after.join(', ')}`)
    const ghost = (await getAgentStatuses(CREW))?.find(s => s.name === SEAT)
    if (ghost !== undefined) listed.push(`#${attempt} ${ghost.status}`)
    if (!after.includes('crew-lead')) leadLost = true
  }
  check(`the lane held the roster lock and was publishing the flag write (its temp file stood) when the removal was called, in at least one of ${ATTEMPTS} attempts`, caught.length > 0, `caught in ${caught.join(', ') || 'none'}`)
  check('the removal reported the seat gone every time', notRemoved.length === 0, notRemoved.length === 0 ? '' : `not in ${notRemoved.join(', ')}`)
  check("the failed seat's removal stands after the flag write the lane had in flight, every time (red on the base: the sync removal spun past the lane's lock, wrote unlocked, and the lane's rename put the seat back as live)", cameBack.length === 0, cameBack.join(' | ') || `gone in all ${ATTEMPTS}`)
  check("the brief's roster never lists the dead seat, idle or busy", listed.length === 0, listed.join(' | ') || `unlisted in all ${ATTEMPTS}`)
  check('the lead still stands in the roster', !leadLost)
}

section('the other order: a flag write that lands after the removal never brings the seat back')
{
  await freshCrew()
  await Promise.resolve(th.removeMemberByAgentId(CREW, SEAT_ID))
  await th.setMemberActive(CREW, SEAT, false)
  await th.setMemberActive(CREW, SEAT, true)
  const after = await rosterNames()
  check('a late flag write on a removed seat writes nothing', !after.includes(SEAT), after.join(', '))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} DEAD-SEAT ROSTER PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL DEAD-SEAT ROSTER PROOFS PASS')
