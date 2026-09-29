#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plugin } from 'bun'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'crew-roles-runs-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_CREW', 'MERCURY_CREW_AGENT', 'MERCURY_CREW_DIR', 'MERCURY_CREWS_DIR', 'MERCURY_TASK_LIST_ID']) delete process.env[key]

const ROOT = join(import.meta.dir, '..', '..')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' Crew roles and the runs board work for crewmates')
console.log(` home ${HOME}`)
console.log('============================================================')

const { getSessionId } = await import('../../src/bootstrap/state.js')
const tasks = (await import('../../src/utils/tasks.js')) as typeof import('../../src/utils/tasks.js')
const roles = (await import('../../src/utils/swarm/roleResolver.js')) as typeof import('../../src/utils/swarm/roleResolver.js')
const charter = (await import('../../src/utils/swarm/crewCharter.js')) as typeof import('../../src/utils/swarm/crewCharter.js')
const addendum = (await import('../../src/utils/swarm/crewmatePromptAddendum.js')) as typeof import('../../src/utils/swarm/crewmatePromptAddendum.js')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.js')
const { CREW_LEAD_NAME } = await import('../../src/utils/swarm/constants.js')
const { crewStoreRoot } = await import('../../src/services/crew/identity.js')
const { sanitizeName } = await import('../../src/utils/swarm/crewHelpers.js')

section('§1 the runs board lists a crewmate\'s task written through the live comms store')
{
  const crew = tasks.getTaskListId()
  check('with no crew, the session\'s crew is keyed by its own id (the task list id)', crew === String(getSessionId()), crew)
  const file = join(crewStoreRoot(), 'livecomms', `${sanitizeName(crew)}.json`)
  mkdirSync(join(crewStoreRoot(), 'livecomms'), { recursive: true })
  const now = Date.now()
  const live = {
    schema: 1,
    crew,
    seq: 3,
    messages: [],
    tasks: {
      '1': { id: '1', subject: 'alpha: wire the claim guard', detail: 'the crewmate alpha wrote this through LiveComms', status: 'in_progress', owner: 'alpha', blockedBy: [], createdBy: 'alpha', createdAt: now, updatedAt: now },
      '2': { id: '2', subject: 'beta: prove the stop', status: 'pending', owner: 'beta', blockedBy: ['1'], createdBy: 'crew-lead', createdAt: now, updatedAt: now },
      '3': { id: '3', subject: 'done already', status: 'completed', blockedBy: [], createdBy: 'alpha', createdAt: now, updatedAt: now },
    },
    busy: {},
  }
  writeFileSync(file, JSON.stringify(live, null, 2))
  const own = await tasks.createTask(crew, { subject: 'the lead\'s own row', description: '', status: 'pending', blocks: [], blockedBy: [] }).catch(() => null)
  const rows = await tasks.listSessionMission()
  const ids = rows.map(r => r.id)
  check('the ledger keeps the session\'s own TaskCreate row', own !== null && ids.includes(own), ids.join(','))
  const liveRows = rows.filter(r => r.id.startsWith('livecomms:'))
  check('the ledger lists the crewmate\'s live comms tasks (3 rows)', liveRows.length === 3, ids.join(','))
  const alphaRow = liveRows.find(r => r.subject === 'alpha: wire the claim guard')
  check('a live comms task keeps its subject, status and owner (the same columns)', alphaRow?.status === 'in_progress' && alphaRow.owner === 'alpha', JSON.stringify(alphaRow))
  const betaRow = liveRows.find(r => r.subject === 'beta: prove the stop')
  check('a live comms task\'s blockedBy names the live row it waits on (keyed like the crew list\'s rows)', betaRow !== undefined && betaRow.blockedBy.length === 1 && betaRow.blockedBy[0] === alphaRow?.id, JSON.stringify(betaRow))
  check('a completed live comms task lists as completed', liveRows.some(r => r.subject === 'done already' && r.status === 'completed'))
  const detail = liveRows.find(r => r.subject === 'alpha: wire the claim guard')
  check('the task\'s detail rides as the row\'s description', detail?.description === 'the crewmate alpha wrote this through LiveComms', JSON.stringify(detail))
}

section('§2 a task written by another crewmate later is read on the next read, and the ledger signal fires')
{
  let fired = 0
  const stop = tasks.onTasksUpdated(() => { fired++ })
  const crew = tasks.getTaskListId()
  const file = join(crewStoreRoot(), 'livecomms', `${sanitizeName(crew)}.json`)
  const current = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Record<string, unknown>; seq: number }
  current.tasks['4'] = { id: '4', subject: 'gamma: a late task', status: 'pending', blockedBy: [], createdBy: 'gamma', createdAt: Date.now(), updatedAt: Date.now() }
  current.seq = 4
  writeFileSync(file, JSON.stringify(current, null, 2))
  const deadline = Date.now() + 8000
  while (fired === 0 && Date.now() < deadline) await sleep(100)
  stop()
  check('the tasks-updated signal fired on the live comms write (the runner relays a fresh ledger)', fired > 0, `fired ${fired}`)
  const rows = await tasks.listSessionMission()
  check('the next read lists the late task', rows.some(r => r.subject === 'gamma: a late task'), rows.map(r => r.subject).join(' | '))
}

section('§3 the runs board keeps its rows: it reads the focused mission ledger, nothing else')
{
  const board = readFileSync(join(ROOT, 'src', 'components', 'tasks', 'BackgroundTasksDialog.tsx'), 'utf8')
  check('the board\'s mission rows are the focused roster\'s mission (no second source)', /missionTasks[^\n]*=\s*roster\.mission/.test(board))
  check('the board reads no crew file and no live comms file itself', !/readCrewFile|crewHelpers|livecomms|liveComms/.test(board))
  const command = readFileSync(join(ROOT, 'src', 'commands', 'tasks', 'index.ts'), 'utf8')
  check('the /runs command and its /tasks alias are unchanged', /name: 'runs'/.test(command) && /aliases: \['tasks'\]/.test(command))
}

section('§4 a crewmate with a role acts in it: the role resolves from the crew record, no crew file, no charter')
{
  const agents = getBuiltInAgents()
  const crewmate = { id: 'task-alpha', name: 'alpha', kind: 'crewmate' as const, model: 'claude-sonnet-5', cwd: PROJECT, worktree: join(PROJECT, '.worktrees', 'alpha') }
  const resolved = roles.resolveCrewmateRole({
    crewmate,
    requestedAgentType: 'mercury-scout',
    agents,
    prompt: 'Map the claim guard\'s call sites and report file:line for each.',
  } as never)
  check('the role is the requested agent type', resolved.agentType === 'mercury-scout', resolved.agentType)
  check('the role packet names the crewmate from the crew record', resolved.rolePacket.crewmateName === 'alpha', JSON.stringify(resolved.rolePacket))
  check('the packet\'s mission is the first line of the prompt', resolved.rolePacket.mission.startsWith('Map the claim guard'), resolved.rolePacket.mission)
  check('the packet says what the crewmate owns: its worktree (a stated start fact, nothing invented)', resolved.rolePacket.owns.includes(crewmate.worktree), JSON.stringify(resolved.rolePacket.owns))
  check('the packet hands off to the lead with no charter', resolved.rolePacket.handoffTo === CREW_LEAD_NAME && resolved.charter === null, JSON.stringify(resolved.rolePacket))
  const prompt = [addendum.buildCrewmateAddendum(), `# Role contract (${resolved.agentType})`, roles.getRoleSystemPrompt(resolved.definition!) ?? '', charter.formatRolePacketForContext(resolved.rolePacket)].join('\n')
  check('the composed prompt carries the role words for alpha', prompt.includes('# Your assignment — alpha (mercury-scout)'), prompt.split('\n').filter(l => l.startsWith('# ')).join(' | '))
  check('the composed prompt carries the scout\'s own contract', /scout/i.test(roles.getRoleSystemPrompt(resolved.definition!) ?? ''))
  const seat = roles.resolveCrewmateRole({
    crewmate: { id: 'seat:beta', name: 'beta', kind: 'seat' as const, model: 'claude-sonnet-5', cwd: PROJECT, worktree: null },
    agents,
    prompt: 'Review the guard.',
  } as never)
  check('a seat with no role word is itself (agentType = its name), owning its working folder', seat.agentType === 'beta' && seat.rolePacket.owns.includes(PROJECT), JSON.stringify(seat.rolePacket))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CREW ROLES-AND-RUNS PROOFS PASS')
else console.log(`❌ ${failures} CREW ROLES-AND-RUNS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.chdir(ROOT)
rmSync(HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
