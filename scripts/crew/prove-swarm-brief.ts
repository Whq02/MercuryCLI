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
check('the earlier seat keeps the brief it was first given: Parser joining does not re-render Docs, so a re-entry re-sends the same system prompt', seam.swarmBrief('docs') === alone)
await seam.latchSwarmAgent('judge', 'Judge')
const third = seam.swarmBrief('judge')
check('a seat latched later is briefed with the seats already there, each with its team, never itself', third !== null && third.startsWith('You are Judge on this session\'s live crew board, with the lead (main) and Docs, Parser (engine);'))
check('Parser\'s brief holds across Judge\'s arrival too', seam.swarmBrief('parser') === live)
await seam.latchSwarmAgent('late', 'Late')
const recorded = 'You are Late, team fixture, on this session\'s live crew board, with the lead (main) and Alpha (fixture); a seat that joins later appears in a board read.'
check('a road resumed with the brief its sidecar recorded re-sends those words, not a fresh render, on that call and the next', seam.swarmBrief('late', recorded) === recorded && seam.swarmBrief('late') === recorded)
check('the brief carries the four habits', ['post a blocker', 'an ask', 'answer an ask', 'post a result', 'read the board at a boundary'].every(habit => live!.includes(habit)))
check('the brief carries the three addresses and keeps the final report', ['@name reaches a seat', '@team a team', '@main the lead', 'never replaces your final report'].every(part => live!.includes(part)))
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { formatDeferredToolLine, isDeferredToolFor } = await import('../../src/tools/ToolSearchTool/prompt.ts')
for (const unattended of [false, true]) {
  const hint = formatDeferredToolLine(AgentTool, unattended)
  check('the launcher roster line names launch, seat, swarm, agents, team and wave', ['launch', 'seat', 'swarm', 'agents', 'team', 'wave'].every(word => hint.includes(word)))
}
check('the launcher stays deferred on cloud routes', isDeferredToolFor(AgentTool, 'claude-fable-5-1') && isDeferredToolFor(AgentTool, 'gemini-4-argon'))
const boardTool = seam.swarmTools()[0]!
const remedy = (text: string) => text.includes('Crewmate') && text.includes('ToolSearch select:Crewmate') && text.includes('launch')
const leadTools = [AgentTool, boardTool]
check('the lead board description names the offered launcher and exact load query', remedy(await boardTool.description(undefined, { tools: leadTools })))
check('the lead board prompt names the offered launcher and exact load query', remedy(await boardTool.prompt({ tools: leadTools } as never)))
const empty = await boardTool.call({ op: 'read' } as never, { options: { tools: leadTools } } as never, (() => {}) as never, {} as never)
check('an empty board read names the launcher without inventing a post', remedy(JSON.stringify(empty.data)) && seam.swarmStore()!.view().events.length === 0)
const leadLaunches = (text: string) => text.includes('The lead launches seats.') && !text.includes('select:Crewmate')
check('the enrolled seat is told that the lead launches seats', leadLaunches(live!))
check('a child board description names the lead rather than an absent launcher', leadLaunches(await boardTool.description(undefined, { tools: [boardTool] })))
check('a child board prompt names the lead rather than an absent launcher', leadLaunches(await boardTool.prompt({ tools: [boardTool] } as never)))
const childEmpty = await boardTool.call({ op: 'read' } as never, { agentId: 'parser', options: { tools: [boardTool] } } as never, (() => {}) as never, {} as never)
check('a child empty read names the lead rather than an absent launcher', leadLaunches(JSON.stringify(childEmpty.data)))
const assignedCaptain = seam.swarmStore()!.assignCaptain(seam.swarmPrincipal()!, 'engine', 'parser')
check('the captain reads the same lead-owned launch road', assignedCaptain.ok && leadLaunches(seam.swarmBrief('parser')!))
seam.swarmStore()?.close()

const launch = readFileSync(new URL('../../src/tools/AgentTool/runAgent.ts', import.meta.url), 'utf8')
check('the launch road pushes the brief into an enrolled crewmate\'s system prompt, after the structured-output words, handing the seam the brief a resume carries', /structured payload is the contract[\s\S]{0,200}const swarmWords = swarm \? swarmBrief\(agentId, override\?\.swarmBrief\) : null\n\s+if \(swarmWords !== null\) systemPrompt\.push\(swarmWords\)/.test(launch))
check('the launch sidecar records the brief the crewmate was given', /\.\.\.\(swarmWords !== null \? \{ swarmBrief: swarmWords \} : \{\}\),/.test(launch))
const resume = readFileSync(new URL('../../src/tools/AgentTool/resumeAgent.ts', import.meta.url), 'utf8')
check('the resume road hands the recorded brief back as the override', /\.\.\.\(meta\?\.swarmBrief !== undefined \? \{ swarmBrief: meta\.swarmBrief \} : \{\}\),/.test(resume))
const leadPrompt = readFileSync(new URL('../../src/tools/AgentTool/prompt.ts', import.meta.url), 'utf8')
check('the lead\'s Crewmate prompt says what an enrolled crewmate is told and how its posts arrive', leadPrompt.includes('enrolled on the live crew board and told its name, its `team` and the seats already there') && leadPrompt.includes('`[name] [team] [kind]:` rows between turns'))
console.log(`swarm brief: ${checks} checks passed`)
