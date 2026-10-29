#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBuiltInAgents } from '../../src/tools/AgentTool/builtInAgents.js'
import { REVIEW_BRIEF } from '../../src/tools/AgentTool/reviewerPolicy.js'
import { VERIFIER_BRIEF } from '../../src/commands/verify.js'
import { MERCURY_DOCS_SKILL_NAME } from '../../src/skills/bundled/mercuryDocs.js'
import { getIsInteractive, setIsInteractive } from '../../src/bootstrap/state.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-agent-roster')

{
  const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
  const contract = readFileSync(join(ROOT, 'src/prompt/mercuryContract.ts'), 'utf8')
  check('§1 the identity is stated by the constitution, once: the part supplier carries no identity line of its own', !/You are Mercury/.test(prompts) && contract.includes("You are Mercury, the coding agent working in the operator's terminal."))
  check('§1 the constitution names the operator and the honesty line', contract.includes("Follow the operator's stated preferences on scope, approach, delegation and communication ahead of your defaults.") && contract.includes('Never invent a result or present an assumption as an observation.'))
}

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
  check('§2 the roster registers exactly two built-ins, crew then scout', agents.map(a => a.agentType).join(',') === 'mercury-crew,mercury-scout', agents.map(a => a.agentType).join(', '))
  for (const a of agents) {
    const prompt = promptTextOf(a)
    check(`§2 ${a.agentType}: an own prompt that names Mercury, or none at all (the identity floor leads every seat's sections)`, prompt === '' || /Mercury/.test(prompt))
    check(`§2 ${a.agentType}: has a mission (whenToUse)`, typeof a.whenToUse === 'string' && a.whenToUse.length > 20)
    check(`§2 ${a.agentType}: model rule is never a lightweight tier`, a.model !== 'haiku', String(a.model))
  }
  const crew = byType.get('mercury-crew')
  check('§2 mercury-crew carries every tool and no own prompt: the floor, the doctrine, the notes and the environment are its whole prompt', JSON.stringify(crew?.tools) === '["*"]' && promptTextOf(crew!) === '')
}

{
  const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const launchPlan = readFileSync(join(ROOT, 'src/utils/crew/agentLaunchPlan.ts'), 'utf8')
  check('§3 the Crewmate tool resolves through the ONE launch-plan builder', agentTool.includes('buildAgentLaunchPlan({'))
  check('§3 the plan builder reads the requested type as written — no decode seam', launchPlan.includes('(i.requestedType || undefined) ?? i.defaultAgentType') && !launchPlan.includes('decodeAgentType'))
  const constants = readFileSync(join(ROOT, 'src/tools/AgentTool/constants.ts'), 'utf8')
  check('§3 the Crewmate tool constants carry no type translation table', !/Record<string, string>/.test(constants) && constants.includes('new Set([MERCURY_SCOUT_AGENT_TYPE])'))
}

{
  check('§4 the review brief carries the closing line verbatim (REVIEW: CLEAN | REVIEW: FINDINGS <count>)', REVIEW_BRIEF.includes('`REVIEW: CLEAN`') && REVIEW_BRIEF.includes('`REVIEW: FINDINGS <count>`'))
  check('§4 the review brief names the one write (the receipt\'s Review section)', REVIEW_BRIEF.includes('section: "## Review"'))
  check('§4 the verifier brief carries the verdict contract verbatim (VERDICT: PASS|FAIL|PARTIAL)', VERIFIER_BRIEF.includes('`VERDICT: ` then one of `PASS`, `FAIL`, `PARTIAL`'))
  check("§4 the verifier brief opens as Mercury's break-it charge", VERIFIER_BRIEF.startsWith("You are verifying someone else's work for Mercury."))
  const verify = readFileSync(join(ROOT, 'src/commands/verify.ts'), 'utf8')
  check('§4 /verify hands the work and brief directly to a crew agent', verify.includes('AGENT_TOOL_NAME') && verify.includes('MERCURY_CREW_AGENT_TYPE') && verify.includes('verifierPrompt(work)'))
  const taskUpdate = readFileSync(join(ROOT, 'src/tools/TaskUpdateTool/prompt.ts'), 'utf8')
  check('§4 the task-list verification nudge names the command', taskUpdate.includes('Run /verify to check the work'))
}

{
  const scout = byType.get('mercury-scout')
  check('§5 mercury-scout registered LIVE', Boolean(scout))
  check('§5 scout inherits the session model', scout?.model === 'inherit', String(scout?.model))
  const edits = ['Edit', 'Write', 'NotebookEdit']
  const readOnly = (list?: string[]) => Array.isArray(list) && edits.every(t => list.some(d => d.includes(t)))
  check('§5 scout disallows the mutation tools', readOnly(scout?.disallowedTools as string[]))
  check('§5 scout cannot spawn agents', Array.isArray(scout?.disallowedTools) && scout.disallowedTools.includes('Crewmate'))
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
  check("§5 every tool the scout is offered is read-only by the tool's own classification (the shell and the skill door apart)", offered.length > 0 && writers.length === 0, writers.join(',') || `${offered.length} offered`)
  check('§5 the scout keeps the readers and the shell', ['Read', 'Glob', 'Grep', 'Bash'].every(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','))
  check('§5 the scout is offered no editor, no agent spawn, no worktree door and no memory writer', !['Edit', 'Write', 'NotebookEdit', 'Crewmate', 'EnterWorktree', 'ExitWorktree', 'Retain', 'Correct', 'SendMessage', 'ResumeCrewmate', 'CronCreate', 'ScheduleWakeup'].some(n => offered.some(t => t.name === n)), offered.map(t => t.name).join(','))
  const writerAtRest = base.filter(t => t.name !== 'Bash' && !atRest(t))
  check('§5 the ask road denies every writer the pool knows and passes every reader', writerAtRest.length > 0 && (await Promise.all(writerAtRest.filter(t => t.name !== 'Skill').map(t => scoutRefusal(t as never, {})))).every(result => result !== null) && (await Promise.all(offered.filter(t => t.name !== 'Bash').map(t => scoutRefusal(t as never, {})))).every(result => result === null), writerAtRest.map(t => t.name).join(','))
}

{
  const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
  check('§6 the prompt names no docs line of its own: the docs skill\'s roster description carries the law once', !prompts.includes(MERCURY_DOCS_SKILL_NAME) && MERCURY_DOCS_SKILL_NAME === 'mercury-docs')
  check('§6 the skill description answers from the documentation that ships with the install, never from memory', readFileSync(join(ROOT, 'src/skills/bundled/mercuryDocs.ts'), 'utf8').includes('answered from the documentation that ships with this install, never from memory'))
  check('§6 no agent type is advertised for questions about Mercury', !/crewmate_type \\`\$\{MERCURY_/.test(prompts))
  const prevKill = process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  const prevInteractive = getIsInteractive()
  delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  setIsInteractive(false)
  check('§6 the roster mounts in a non-interactive (headless) run', getBuiltInAgents().length === 2)
  process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = '1'
  check('§6 the SDK builtin-agent kill in a non-interactive session is the ONE opt-out: the roster is empty', getBuiltInAgents().length === 0)
  setIsInteractive(true)
  check('§6 the kill does not reach an interactive session', getBuiltInAgents().length === 2)
  if (prevKill === undefined) delete process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS
  else process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS = prevKill
  setIsInteractive(prevInteractive)
}

console.log(failures === 0 ? '\n✓ prove-agent-roster: all green' : `\n✗ prove-agent-roster: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
