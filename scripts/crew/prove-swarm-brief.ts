import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPrincipal } from '../../src/crew/board/contracts.ts'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'brief-home-'))
process.env.MERCURY_CONFIG_DIR = home
const { open } = await import('../../src/crew/board/store.ts')
let checks = 0
const check = (label: string, value: unknown, hint = '') => { assert(value, hint ? `${label} \u2014 ${hint}` : label); console.log(`PASS ${label}`); checks++ }

{
  const board = open(join(home, 'seats.sqlite'), 'seats', () => 0)
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
    check('seats() lists every enrolled seat with its name', seats.map(s => `${s.agent}:${s.name}`).sort().join(' ') === 'docs:Docs main:main parser:Parser', 'seats() in src/crew/board/store.ts must list each enrolled seat once with the name it enrolled under')
    check('a seat enrolled with a team carries it; one without carries none', seats.find(s => s.agent === 'parser')?.team === 'engine' && !('team' in seats.find(s => s.agent === 'docs')!), 'seats() in src/crew/board/store.ts must return team only for a seat enrolled with one')
    const assigned = board.assignTeam(main, 'Docs', 'view')
    check('a team the lead assigns later shows in seats()', assigned.ok && board.seats().find(s => s.agent === 'docs')?.team === 'view', `${JSON.stringify(assigned)} — assignTeam (src/crew/board/store/enrollment.ts) must accept the lead's assignment and seats() must then show the team`)
  } finally { board.close() }
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(home); bootstrap.setCwdState(home); bootstrap.setProjectRoot(home)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/crew/board/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')

check('no road, no brief', seam.swarmBrief('nobody') === null, 'swarmBrief in src/crew/board/seam.ts must return null for an agent with no latched road')
runSwarmCommand('on')
await seam.latchSwarmCrewmate('docs', 'Docs')
const alone = seam.swarmBrief('docs')
check('a seat without a team or peers reads plainly', alone !== null && alone.startsWith('You are Docs on this session\'s live crew board, with the lead (main); a seat that joins later appears in a board read.'), `${alone} — swarmBriefWords in src/crew/board/seam.ts builds the opening of the brief`)
await seam.latchSwarmCrewmate('parser', 'Parser', false, 'engine')
const live = seam.swarmBrief('parser')
check('a latched seat is briefed from the live board: its own name and team, main, and the other seat', live !== null && live.startsWith('You are Parser, team engine, on this session\'s live crew board, with the lead (main) and Docs;'), `${live} — swarmBrief in src/crew/board/seam.ts must render the brief from store.seats() at first call`)
check('the earlier seat keeps the brief it was first given: Parser joining does not re-render Docs, so a re-entry re-sends the same system prompt', seam.swarmBrief('docs') === alone, 'swarmBrief in src/crew/board/seam.ts must cache the first rendered brief on the road (road.brief) and return it unchanged')
await seam.latchSwarmCrewmate('judge', 'Judge')
const third = seam.swarmBrief('judge')
check('a seat latched later is briefed with the seats already there, each with its team, never itself', third !== null && third.startsWith('You are Judge on this session\'s live crew board, with the lead (main) and Docs, Parser (engine);'), `${third} — swarmBriefWords in src/crew/board/seam.ts must list the other seats with their teams and omit the seat itself and main`)
check('Parser\'s brief holds across Judge\'s arrival too', seam.swarmBrief('parser') === live, 'swarmBrief in src/crew/board/seam.ts must keep returning the cached brief (road.brief)')
await seam.latchSwarmCrewmate('late', 'Late')
const recorded = 'You are Late, team fixture, on this session\'s live crew board, with the lead (main) and Alpha (fixture); a seat that joins later appears in a board read.'
check('a road resumed with the brief its sidecar recorded re-sends those words, not a fresh render, on that call and the next', seam.swarmBrief('late', recorded) === recorded && seam.swarmBrief('late') === recorded, 'swarmBrief in src/crew/board/seam.ts must adopt the recorded argument as road.brief when none is cached and return it afterwards')
check('the brief carries the four habits', ['post a blocker', 'an ask', 'answer an ask', 'post a result', 'read the board at a boundary'].every(habit => live!.includes(habit)), `${live} — swarmBriefWords in src/crew/board/seam.ts must keep every habit phrase`)
check('the brief carries the three addresses and keeps the final report', ['@name reaches a seat', '@team a team', '@main the lead', 'never replaces your final report'].every(part => live!.includes(part)), `${live} — swarmBriefWords in src/crew/board/seam.ts must keep the address phrases and the final-report sentence`)
const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { formatDeferredToolLine, isDeferredToolFor } = await import('../../src/tools/tool-search/prompt.ts')
for (const unattended of [false, true]) {
  const hint = formatDeferredToolLine(CrewmateTool, unattended)
  check('the launcher roster line names independent delegation, not a required swarm', hint === 'Crewmate — delegate a bounded task to an independent agent and receive its report', `${hint} — formatDeferredToolLine in src/tools/tool-search/prompt.ts builds this line for the launcher`)
}
check('the launcher stays deferred on cloud routes', isDeferredToolFor(CrewmateTool, 'claude-fable-5-1') && isDeferredToolFor(CrewmateTool, 'gemini-4-argon'), 'isDeferredToolFor in src/tools/tool-search/prompt.ts must report the Crewmate launcher as deferred for these models')
const boardTool = seam.swarmTools()[0]!
const remedy = (text: string) => text.includes('Crewmate') && text.includes('ToolSearch select:Crewmate') && text.includes('launch')
const leadTools = [CrewmateTool, boardTool]
check('the lead board description names the offered launcher and exact load query', remedy(await boardTool.description(undefined, { tools: leadTools })), 'the board tool description in src/crew/board/implementation.ts (LAUNCH, launchWords) must name Crewmate and ToolSearch select:Crewmate when the launcher is among the tools')
const boardPrompt = await boardTool.prompt({ tools: leadTools } as never)
check('the board prompt describes messaging, not the launcher', boardPrompt.startsWith('Read or post on the shared crew board.') && !/Crewmate|ToolSearch|launch agents/.test(boardPrompt), `${boardPrompt.slice(0, 300)} — the board tool prompt in src/crew/board/implementation.ts must start with the messaging words and leave launching to the description`)
const empty = await boardTool.call({ op: 'read' } as never, { options: { tools: leadTools } } as never, (() => {}) as never, {} as never)
check('an empty board read names the launcher without inventing a post', remedy(JSON.stringify(empty.data)) && seam.swarmStore()!.view().events.length === 0, `${JSON.stringify(empty.data).slice(0, 300)} — the read op in src/crew/board/implementation.ts must name the launcher in an empty read and post nothing`)
const leadLaunches = (text: string) => text.includes('The lead launches seats.') && !text.includes('select:Crewmate')
check('the enrolled seat is told that the lead launches seats', leadLaunches(live!), `${live} — swarmBriefWords in src/crew/board/seam.ts must say the lead launches seats`)
check('a child board description names the lead rather than an absent launcher', leadLaunches(await boardTool.description(undefined, { tools: [boardTool] })), 'the board tool description in src/crew/board/implementation.ts (launchWords) must say the lead launches seats when the launcher is not among the tools')
check('a child reads the same board contract, without absent-tool routing', await boardTool.prompt({ tools: [boardTool] } as never) === boardPrompt, 'the board tool prompt in src/crew/board/implementation.ts must not depend on which tools are offered')
const childEmpty = await boardTool.call({ op: 'read' } as never, { agentId: 'parser', options: { tools: [boardTool] } } as never, (() => {}) as never, {} as never)
check('a child empty read names the lead rather than an absent launcher', leadLaunches(JSON.stringify(childEmpty.data)), `${JSON.stringify(childEmpty.data).slice(0, 300)} — the read op in src/crew/board/implementation.ts must say the lead launches seats when the launcher is absent`)
const assignedCaptain = seam.swarmStore()!.assignCaptain(seam.swarmPrincipal()!, 'engine', 'parser')
check('the captain reads the same lead-owned launch road', assignedCaptain.ok && leadLaunches(seam.swarmBrief('parser')!), `${JSON.stringify(assignedCaptain)} — assignCaptain (src/crew/board/store/enrollment.ts) must succeed and the captain brief (swarmBriefWords in src/crew/board/seam.ts) must still say the lead launches seats`)
seam.swarmStore()?.close()

console.log(`swarm brief: ${checks} checks passed`)
