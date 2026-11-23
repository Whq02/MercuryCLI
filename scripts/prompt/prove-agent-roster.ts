#!/usr/bin/env bun
import { join } from 'node:path'
import { getBuiltInAgents } from '../../src/tools/crewmate/builtInAgents.js'
import { REVIEW_BRIEF } from '../../src/tools/crewmate/reviewerPolicy.js'
import { VERIFIER_BRIEF } from '../../src/commands/verify/index.js'
import { getIsInteractive, setIsInteractive } from '../../src/boot/process-state/processState.js'


let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

console.log('prove-agent-roster')


const agents = getBuiltInAgents()
const byType = new Map(agents.map(a => [a.agentType, a]))
function promptTextOf(a: { agentType: string; getSystemPrompt?: (ctx?: unknown) => string }): string {
  try {
    return a.getSystemPrompt?.() ?? ''
  } catch {
    return ''
  }
}
{
  check('§2 the roster registers exactly two built-ins, crew then scout', agents.map(a => a.agentType).join(',') === 'mercury-crew,mercury-scout', agents.map(a => a.agentType).join(', '), 'edit getBuiltInAgents in src/tools/crewmate/builtInAgents.ts so it returns MERCURY_CREW_AGENT then MERCURY_SCOUT_AGENT and no other built-in')
  for (const a of agents) {
    const prompt = promptTextOf(a)
    check(`§2 ${a.agentType}: an own prompt that names Mercury, or none at all (the identity floor leads every seat's sections)`, prompt === '' || /Mercury/.test(prompt), '', 'make this agent getSystemPrompt (its definition under src/tools/crewmate/built-in/) name Mercury, or return an empty prompt')
    check(`§2 ${a.agentType}: has a mission (whenToUse)`, typeof a.whenToUse === 'string' && a.whenToUse.length > 20, '', 'give this agent a whenToUse string longer than 20 characters in its definition under src/tools/crewmate/built-in/')
    check(`§2 ${a.agentType}: model rule is never a lightweight tier`, a.model !== 'haiku', String(a.model), 'set a model other than haiku on this agent in its definition under src/tools/crewmate/built-in/')
  }
  const crew = byType.get('mercury-crew')
  check('§2 mercury-crew carries every tool and no own prompt: the floor, the doctrine, the notes and the environment are its whole prompt', JSON.stringify(crew?.tools) === '["*"]' && promptTextOf(crew!) === '', '', 'in src/tools/crewmate/built-in/mercuryCrewAgent.ts keep tools as the single wildcard entry and give the agent no own system prompt')
}


{
  check('§4 the review brief carries the closing line verbatim (REVIEW: CLEAN | REVIEW: FINDINGS <count>)', REVIEW_BRIEF.includes('`REVIEW: CLEAN`') && REVIEW_BRIEF.includes('`REVIEW: FINDINGS <count>`'), '', 'restore both closing lines in REVIEW_BRIEF in src/tools/crewmate/reviewerPolicy.ts')
  check('§4 the review brief names the one write (the receipt\'s Review section)', REVIEW_BRIEF.includes('section: "## Review"'), '', 'restore the receipt Review section instruction in REVIEW_BRIEF in src/tools/crewmate/reviewerPolicy.ts')
  check('§4 the verifier brief carries the verdict contract verbatim (VERDICT: PASS|FAIL|PARTIAL)', VERIFIER_BRIEF.includes('`VERDICT: ` then one of `PASS`, `FAIL`, `PARTIAL`'), '', 'restore the verdict line in VERIFIER_BRIEF in src/commands/verify/index.ts')
  check("§4 the verifier brief opens as Mercury's break-it charge", VERIFIER_BRIEF.startsWith("You are verifying someone else's work for Mercury."), '', 'restore the opening sentence of VERIFIER_BRIEF in src/commands/verify/index.ts')
}

{
  const scout = byType.get('mercury-scout')
  check('§5 mercury-scout registered LIVE', Boolean(scout), '', 'getBuiltInAgents in src/tools/crewmate/builtInAgents.ts must return MERCURY_SCOUT_AGENT with agentType mercury-scout')
  check('§5 scout inherits the session model', scout?.model === 'inherit', String(scout?.model), 'set model to inherit in src/tools/crewmate/built-in/mercuryScoutAgent.ts')
  const edits = ['Edit', 'Write', 'NotebookEdit']
  const readOnly = (list?: string[]) => Array.isArray(list) && edits.every(t => list.some(d => d.includes(t)))
  check('§5 scout disallows the mutation tools', readOnly(scout?.disallowedTools as string[]), '', 'list Edit, Write and NotebookEdit in disallowedTools in src/tools/crewmate/built-in/mercuryScoutAgent.ts')
  check('§5 scout cannot spawn agents', Array.isArray(scout?.disallowedTools) && scout.disallowedTools.includes('Crewmate'), '', 'list Crewmate in disallowedTools in src/tools/crewmate/built-in/mercuryScoutAgent.ts')
  const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
  const { restrictScoutTools, scoutRefusal } = await import('../../src/tools/crewmate/scoutPolicy.js')
  type Classified = { name: string; isReadOnly: (input: Record<string, unknown>) => boolean }
  const base = getAllBaseTools() as unknown as Classified[]
  const offered = restrictScoutTools(base as never) as unknown as Classified[]
  const atRest = (t: Classified): boolean => {
    try {
      return t.isReadOnly({}) === true
    } catch {
      return false
    }
  }
  const writers = offered.filter(t => t.name !== 'Bash' && t.name !== 'Skill' && !atRest(t)).map(t => t.name)
  check("§5 every tool the scout is offered is read-only by the tool's own classification (the shell and the skill door apart)", offered.length > 0 && writers.length === 0, writers.join(',') || `${offered.length} offered`, 'restrictScoutTools in src/tools/crewmate/scoutPolicy.ts must drop the tools named in the detail, or the detail is empty because nothing is offered')
  check('§5 the scout keeps the readers and the shell', ['Read', 'Glob', 'Grep', 'Bash'].every(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','), 'restrictScoutTools in src/tools/crewmate/scoutPolicy.ts must keep Read, Glob, Grep and Bash')
  check('§5 the scout is offered no editor, no agent spawn, no worktree door and no memory writer', !['Edit', 'Write', 'NotebookEdit', 'Crewmate', 'EnterWorktree', 'ExitWorktree', 'Retain', 'Correct', 'SendMessage', 'ResumeCrewmate', 'CronCreate', 'ScheduleWakeup'].some(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','), 'restrictScoutTools and SCOUT_DENIED_TOOLS in src/tools/crewmate/scoutPolicy.ts must drop any of these tools named in the detail')
  const writerAtRest = base.filter(t => t.name !== 'Bash' && !atRest(t))
  check('§5 the ask road denies every writer the pool knows and passes every reader', writerAtRest.length > 0 && (await Promise.all(writerAtRest.filter(t => t.name !== 'Skill').map(t => scoutRefusal(t as never, {})))).every(result => result !== null) && (await Promise.all(offered.filter(t => t.name !== 'Bash').map(t => scoutRefusal(t as never, {})))).every(result => result === null), writerAtRest.map(t => t.name).join(','), 'scoutRefusal in src/tools/crewmate/scoutPolicy.ts must refuse every writer tool in the detail and return null for every tool restrictScoutTools offers')
}

{
  const prevKill = process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  const prevInteractive = getIsInteractive()
  delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  setIsInteractive(false)
  check('§6 the roster mounts in a non-interactive (headless) run', getBuiltInAgents().length === 2, '', 'getBuiltInAgents in src/tools/crewmate/builtInAgents.ts must return both agents when the kill flag is unset')
  process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = '1'
  check('§6 the SDK builtin-agent kill in a non-interactive session is the ONE opt-out: the roster is empty', getBuiltInAgents().length === 0, '', 'getBuiltInAgents in src/tools/crewmate/builtInAgents.ts must return an empty list when MERCURY_HOST_DISABLE_BUILTIN_AGENTS is set in a non-interactive session')
  setIsInteractive(true)
  check('§6 the kill does not reach an interactive session', getBuiltInAgents().length === 2, '', 'getBuiltInAgents in src/tools/crewmate/builtInAgents.ts must apply the kill only when the session is non-interactive')
  if (prevKill === undefined) delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  else process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = prevKill
  setIsInteractive(prevInteractive)
}

console.log(failures === 0 ? '\n✓ prove-agent-roster: all green' : `\n✗ prove-agent-roster: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
