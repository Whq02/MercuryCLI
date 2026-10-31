import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPrincipal } from '../../src/services/crewBoard/contracts.ts'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'brief-home-'))
process.env.MERCURY_CONFIG_DIR = home
const { open } = await import('../../src/services/crewBoard/store.ts')
const { DEFAULT_BOARD_LIMITS } = await import('../../src/services/crewBoard/contracts.ts')
let checks = 0
const check = (label: string, value: unknown) => { assert(value, label); console.log(`PASS ${label}`); checks++ }

{
  const board = open(join(home, 'seats.sqlite'), 'seats', DEFAULT_BOARD_LIMITS, () => 0)
  const seat = (agentId: string, name = agentId, team?: string): BoardPrincipal => {
    const principal = { author: { sessionId: 'seats', agentId, executionId: 'run' }, name, team }
    board.enroll(principal)
    return principal
  }
  const main = seat('main')
  seat('parser', 'Parser', 'engine')
  seat('docs', 'Docs')
  try {
    const seats = board.seats()
    check('seats() lists every enrolled seat with its name', seats.map(s => `${s.agent}:${s.name}`).sort().join(' ') === 'docs:Docs main:main parser:Parser')
    check('a seat enrolled with a team carries it; one without carries none', seats.find(s => s.agent === 'parser')?.team === 'engine' && !('team' in seats.find(s => s.agent === 'docs')!))
    const assigned = board.assignTeam(main, 'Docs', 'view')
    check('a team the lead assigns later shows in seats()', assigned.ok && board.seats().find(s => s.agent === 'docs')?.team === 'view')
  } finally { board.close() }
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(home); bootstrap.setCwdState(home); bootstrap.setProjectRoot(home)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')

check('no road, no brief', seam.swarmBrief('nobody') === null)
runSwarmCommand('on')
await seam.latchSwarmAgent('docs', 'Docs')
const alone = seam.swarmBrief('docs')
check('a seat without a team or peers reads plainly', alone !== null && alone.startsWith('You are Docs on this session\'s live crew board, with the lead (main); a seat that joins later appears in a board read.'))
await seam.latchSwarmAgent('parser', 'Parser', false, false, 'engine')
const live = seam.swarmBrief('parser')
check('a latched seat is briefed from the live board: its own name and team, main, and the other seat', live !== null && live.startsWith('You are Parser, team engine, on this session\'s live crew board, with the lead (main) and Docs;'))
check('the other seat sees Parser with its team and not itself', seam.swarmBrief('docs')?.startsWith('You are Docs on this session\'s live crew board, with the lead (main) and Parser (engine);') === true)
check('the brief carries the four habits', ['post a blocker', 'an ask', 'answer an ask', 'post a result', 'read the board at a boundary'].every(habit => live!.includes(habit)))
check('the brief carries the three addresses and keeps the final report', ['@name reaches a seat', '@team a team', '@main the lead', 'never replaces your final report'].every(part => live!.includes(part)))
seam.swarmStore()?.close()

const launch = readFileSync(new URL('../../src/tools/AgentTool/runAgent.ts', import.meta.url), 'utf8')
check('the launch road pushes the brief into an enrolled crewmate\'s system prompt, after the structured-output words', /structured payload is the contract[\s\S]{0,200}const swarmWords = swarm \? swarmBrief\(agentId\) : null\n\s+if \(swarmWords !== null\) systemPrompt\.push\(swarmWords\)/.test(launch))
const leadPrompt = readFileSync(new URL('../../src/tools/AgentTool/prompt.ts', import.meta.url), 'utf8')
check('the lead\'s Crewmate prompt says what an enrolled crewmate is told and how its posts arrive', leadPrompt.includes('enrolled on the live crew board and told its name, its `team` and the seats already there') && leadPrompt.includes('`[name] [team] [kind]:` rows between turns'))
console.log(`swarm brief: ${checks} checks passed`)
