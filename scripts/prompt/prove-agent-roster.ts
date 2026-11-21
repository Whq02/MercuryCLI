#!/usr/bin/env bun
import { join } from 'node:path'
import { getBuiltInAgents } from '../../src/tools/AgentTool/builtInAgents.js'
import { REVIEW_BRIEF } from '../../src/tools/AgentTool/reviewerPolicy.js'
import { VERIFIER_BRIEF } from '../../src/commands/verify.js'
import { getIsInteractive, setIsInteractive } from '../../src/bootstrap/state.js'


let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shownDetail = cond ? detail : [detail, hint].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shownDetail ? ` — ${shownDetail}` : ''}`)
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
  check('§2 the roster registers exactly two built-ins, crew then scout', agents.map(a => a.agentType).join(',') === 'mercury-crew,mercury-scout', agents.map(a => a.agentType).join(', '), 'change the built-in agent list returned by getBuiltInAgents in src/tools/AgentTool/builtInAgents.ts')
  for (const a of agents) {
    const prompt = promptTextOf(a)
    check(`§2 ${a.agentType}: an own prompt that names Mercury, or none at all (the identity floor leads every seat's sections)`, prompt === '' || /Mercury/.test(prompt), '', 'the agent getSystemPrompt in src/tools/AgentTool/builtInAgents.ts (or the file it loads the agent from) must name Mercury or return no prompt')
    check(`§2 ${a.agentType}: has a mission (whenToUse)`, typeof a.whenToUse === 'string' && a.whenToUse.length > 20, '', 'give the agent a whenToUse string of more than 20 characters in its definition under src/tools/AgentTool/')
    check(`§2 ${a.agentType}: model rule is never a lightweight tier`, a.model !== 'haiku', String(a.model), 'set a model other than haiku on the agent definition under src/tools/AgentTool/')
  }
  const crew = byType.get('mercury-crew')
  check('§2 mercury-crew carries every tool and no own prompt: the floor, the doctrine, the notes and the environment are its whole prompt', JSON.stringify(crew?.tools) === '["*"]' && promptTextOf(crew!) === '', JSON.stringify(crew?.tools), 'mercury-crew in src/tools/AgentTool/ must keep tools ["*"] and no getSystemPrompt text')
}


{
  check('§4 the review brief carries the closing line verbatim (REVIEW: CLEAN | REVIEW: FINDINGS <count>)', REVIEW_BRIEF.includes('`REVIEW: CLEAN`') && REVIEW_BRIEF.includes('`REVIEW: FINDINGS <count>`'), '', 'restore the two closing lines in REVIEW_BRIEF in src/tools/AgentTool/reviewerPolicy.ts')
  check('§4 the review brief names the one write (the receipt\'s Review section)', REVIEW_BRIEF.includes('section: "## Review"'), '', 'restore the receipt Review section write in REVIEW_BRIEF in src/tools/AgentTool/reviewerPolicy.ts')
  check('§4 the verifier brief carries the verdict contract verbatim (VERDICT: PASS|FAIL|PARTIAL)', VERIFIER_BRIEF.includes('`VERDICT: ` then one of `PASS`, `FAIL`, `PARTIAL`'), '', 'restore the verdict contract line in VERIFIER_BRIEF in src/commands/verify.ts')
  check("§4 the verifier brief opens as Mercury's break-it charge", VERIFIER_BRIEF.startsWith("You are verifying someone else's work for Mercury."), '', 'restore the opening sentence of VERIFIER_BRIEF in src/commands/verify.ts')
}

{
  const scout = byType.get('mercury-scout')
  check('§5 mercury-scout registered LIVE', Boolean(scout), '', 'register mercury-scout in getBuiltInAgents in src/tools/AgentTool/builtInAgents.ts')
  check('§5 scout inherits the session model', scout?.model === 'inherit', String(scout?.model), 'set model to inherit on the mercury-scout definition under src/tools/AgentTool/')
  const edits = ['Edit', 'Write', 'NotebookEdit']
  const readOnly = (list?: string[]) => Array.isArray(list) && edits.every(t => list.some(d => d.includes(t)))
  check('§5 scout disallows the mutation tools', readOnly(scout?.disallowedTools as string[]), '', 'add Edit, Write and NotebookEdit to the mercury-scout disallowedTools under src/tools/AgentTool/')
  check('§5 scout cannot spawn agents', Array.isArray(scout?.disallowedTools) && scout.disallowedTools.includes('Crewmate'), '', 'add Crewmate to the mercury-scout disallowedTools under src/tools/AgentTool/')
  const { getAllBaseTools } = await import('../../src/tools.js')
  const { restrictScoutTools, scoutRefusal } = await import('../../src/tools/AgentTool/scoutPolicy.js')
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
  check("§5 every tool the scout is offered is read-only by the tool's own classification (the shell and the skill door apart)", offered.length > 0 && writers.length === 0, writers.join(',') || `${offered.length} offered`, 'a writer tool listed here is offered to the scout; restrictScoutTools in src/tools/AgentTool/scoutPolicy.ts must drop it')
  check('§5 the scout keeps the readers and the shell', ['Read', 'Glob', 'Grep', 'Bash'].every(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','), 'restrictScoutTools in src/tools/AgentTool/scoutPolicy.ts dropped a reader or the shell')
  check('§5 the scout is offered no editor, no agent spawn, no worktree door and no memory writer', !['Edit', 'Write', 'NotebookEdit', 'Crewmate', 'EnterWorktree', 'ExitWorktree', 'Retain', 'Correct', 'SendMessage', 'ResumeCrewmate', 'CronCreate', 'ScheduleWakeup'].some(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','), 'restrictScoutTools in src/tools/AgentTool/scoutPolicy.ts must drop every tool of that list')
  const writerAtRest = base.filter(t => t.name !== 'Bash' && !atRest(t))
  check('§5 the ask road denies every writer the pool knows and passes every reader', writerAtRest.length > 0 && (await Promise.all(writerAtRest.filter(t => t.name !== 'Skill').map(t => scoutRefusal(t as never, {})))).every(result => result !== null) && (await Promise.all(offered.filter(t => t.name !== 'Bash').map(t => scoutRefusal(t as never, {})))).every(result => result === null), writerAtRest.map(t => t.name).join(','), 'scoutRefusal in src/tools/AgentTool/scoutPolicy.ts must refuse every writer and pass every offered reader')
}

{
  const prevKill = process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  const prevInteractive = getIsInteractive()
  delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  setIsInteractive(false)
  check('§6 the roster mounts in a non-interactive (headless) run', getBuiltInAgents().length === 2, '', 'getBuiltInAgents in src/tools/AgentTool/builtInAgents.ts must return both agents when the kill variable is unset')
  process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = '1'
  check('§6 the SDK builtin-agent kill in a non-interactive session is the ONE opt-out: the roster is empty', getBuiltInAgents().length === 0, '', 'getBuiltInAgents in src/tools/AgentTool/builtInAgents.ts must return no agent for a non-interactive session with MERCURY_HOST_DISABLE_BUILTIN_AGENTS set')
  setIsInteractive(true)
  check('§6 the kill does not reach an interactive session', getBuiltInAgents().length === 2, '', 'getBuiltInAgents in src/tools/AgentTool/builtInAgents.ts must ignore the kill variable when the session is interactive')
  if (prevKill === undefined) delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  else process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = prevKill
  setIsInteractive(prevInteractive)
}

console.log(failures === 0 ? '\n✓ prove-agent-roster: all green' : `\n✗ prove-agent-roster: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
