#!/usr/bin/env bun
// ============================================================================
//  scripts/prompt/prove-agent-roster.ts — the Mercury agent KERNEL + ROSTER
//  oracle (mercury-feel; DoD: "every visible built-in agent has a
//  Mercury name, a specific mission, an explicit model rule, a concise
//  output contract, and a real activation path" + "the main prompt has one
//  early Mercury identity kernel").
//
//    §1 the system prompt's FIRST words are the Mercury identity kernel
//    §2 every registered built-in: Mercury-native prompt identity, a
//       mission (whenToUse), a model rule that is never a lightweight tier
//    §3 no legacy vocabulary (the retired "-borne" register; the claude/Explore/
//       Plan ids are not registered directly)
//    §4 the migration map resolves every legacy id to a REGISTERED agent
//    §5 the literal parser contracts survive VERBATIM (background sentinels,
//       verifier verdict tokens)
//    §6 scout/architect are LIVE, read-only, correctly modeled; the dead
//       enabler machinery is deleted repo-wide
//
//  Run: ~/.bun/bin/bun run scripts/prompt/prove-agent-roster.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBuiltInAgents, LEGACY_SUBAGENT_ALIASES } from '../../src/tools/AgentTool/builtInAgents.js'
import { isGuideAgentMounted, MERCURY_GUIDE_AGENT_TYPE } from '../../src/tools/AgentTool/built-in/mercuryGuideAgent.js'
import { getIsInteractive, setIsInteractive } from '../../src/bootstrap/state.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-agent-roster')

// §1 — the identity kernel opens the prompt
{
  const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
  check('§1 the intro section opens with the Mercury identity kernel', prompts.includes('You are Mercury — a private, source-built terminal coding harness'))
  check('§1 the generic "interactive agent that helps users" opener is gone', !prompts.includes('You are an interactive agent that helps users '))
  check('§1 the kernel names the operator allegiance', prompts.includes('loyal to Mercury and its operator through candor, decisive help, and faithful completion'))
}

// §2 — the registered roster
const agents = getBuiltInAgents()
const byType = new Map(agents.map(a => [a.agentType, a]))
// Some prompts need a live toolUseContext (the guide lists active agents);
// fall back to the def's SOURCE text for those — identity words are static.
const SOURCE_BY_TYPE: Record<string, string> = {
  'mercury-guide': 'src/tools/AgentTool/built-in/mercuryGuideAgent.ts',
}
function promptTextOf(a: { agentType: string; getSystemPrompt?: (ctx?: unknown) => string }): string {
  try {
    return a.getSystemPrompt?.() ?? ''
  } catch {
    const src = SOURCE_BY_TYPE[a.agentType]
    return src ? readFileSync(join(ROOT, src), 'utf8') : ''
  }
}
{
  check('§2 roster registers ≥ 6 built-ins', agents.length >= 6, agents.map(a => a.agentType).join(', '))
  for (const a of agents) {
    const prompt = promptTextOf(a)
    check(`§2 ${a.agentType}: Mercury-native identity in its prompt`, /Mercury/.test(prompt))
    check(`§2 ${a.agentType}: has a mission (whenToUse)`, typeof a.whenToUse === 'string' && a.whenToUse.length > 20)
    check(`§2 ${a.agentType}: model rule is never a lightweight tier`, a.model !== 'haiku', String(a.model))
  }
}

// §3 — legacy vocabulary gone
{
  const legacy = agents.filter(a => ['claude', 'Explore', 'Plan'].includes(a.agentType))
  check('§3 no built-in registers under a legacy id', legacy.length === 0, legacy.map(a => a.agentType).join(', '))
  for (const a of agents) {
    check(`§3 ${a.agentType}: no retired-borne vocabulary in its prompt`, !promptTextOf(a).includes(['temp', 'est-borne'].join('')))
  }
}

// §4 — the migration map resolves to registered agents
{
  for (const [legacy, target] of Object.entries(LEGACY_SUBAGENT_ALIASES)) {
    check(`§4 legacy '${legacy}' → '${target}' resolves to a REGISTERED agent`, byType.has(target))
  }
  check('§4 the wrapper-routed Explore id resolves', LEGACY_SUBAGENT_ALIASES['Explore'] === 'mercury-scout')
  const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const launchPlan = readFileSync(join(ROOT, 'src/utils/swarm/agentLaunchPlan.ts'), 'utf8')
  check('§4 the Agent tool resolves through the ONE launch-plan builder', agentTool.includes('buildAgentLaunchPlan({'))
  check('§4 the plan builder decodes via the ONE alias truth (roleResolver)', launchPlan.includes('decodeAgentType(i.requestedType)'))
  check('§4 the Agent tool keeps NO alias-map copy of its own', !agentTool.includes('LEGACY_SUBAGENT_ALIASES'))
}

// §5 — literal parser contracts survive verbatim
{
  const bg = promptTextOf(byType.get('mercury-background')!)
  check("§5 background sentinels verbatim: `result:`", bg.includes('`result:`') || bg.includes('\\`result:\\`'))
  check("§5 background sentinels verbatim: `needs input:`", bg.includes('needs input:'))
  check("§5 background sentinels verbatim: `failed:`", bg.includes('failed:'))
  const verifier = promptTextOf(byType.get('verification')!)
  check('§5 verifier verdict contract verbatim (VERDICT: PASS|FAIL|PARTIAL)', /VERDICT/.test(verifier) && /PASS/.test(verifier) && /FAIL/.test(verifier))
  check("§5 verifier opens as Mercury's verification specialist", verifier.startsWith("You are Mercury's verification specialist"))
}

// §6 — scout/architect live + safe; the dead enabler is deleted repo-wide
{
  const scout = byType.get('mercury-scout')
  const architect = byType.get('mercury-architect')
  check('§6 mercury-scout registered LIVE', Boolean(scout))
  check('§6 mercury-architect registered LIVE', Boolean(architect))
  check("§6 scout inherits the session model (never-lightweight floor guards the resolved tier; a Claude-tier pin stranded a non-Anthropic session)", scout?.model === 'inherit', String(scout?.model))
  check("§6 architect inherits the session model", architect?.model === 'inherit', String(architect?.model))
  const edits = ['Edit', 'Write', 'NotebookEdit']
  const readOnly = (list?: string[]) => Array.isArray(list) && edits.every(t => list.some(d => d.includes(t)))
  check('§6 scout disallows the mutation tools', readOnly(scout?.disallowedTools as string[]))
  check('§6 architect disallows the mutation tools', readOnly(architect?.disallowedTools as string[]))
  const grep = execSync(`grep -rn "areExplorePlanAgentsEnabled" ${join(ROOT, 'src')} || true`, { encoding: 'utf8' }).trim()
  check('§6 the dead enabler is deleted from src/', grep === '', grep.slice(0, 120))
}

// §7 — the guide mounts in EVERY session, headless `-p` included; the SDK
// builtin-agent kill (env + non-interactive) is the ONE opt-out, and the
// prompt's guide line reads the same predicate (one mount law).
{
  const prevEntry = process.env.MERCURY_ENTRYPOINT
  const prevKill = process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS
  const prevInteractive = getIsInteractive()
  const mounted = (): boolean => getBuiltInAgents().some(a => a.agentType === MERCURY_GUIDE_AGENT_TYPE)
  delete process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS
  process.env.MERCURY_ENTRYPOINT = 'sdk'
  setIsInteractive(false)
  check('§7 the guide is mounted under the sdk entrypoint (a headless -p run)', isGuideAgentMounted() && mounted())
  process.env.MERCURY_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  check('§7 the guide is mounted in an interactive session', isGuideAgentMounted() && mounted())
  process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS = '1'
  setIsInteractive(false)
  check('§7 the SDK builtin-agent kill in a non-interactive session is the ONE opt-out: the guide is unmounted and the roster is empty', !isGuideAgentMounted() && getBuiltInAgents().length === 0)
  setIsInteractive(true)
  check('§7 the kill does not reach an interactive session', isGuideAgentMounted() && mounted())
  const guideSrc = readFileSync(join(ROOT, 'src/tools/AgentTool/built-in/mercuryGuideAgent.ts'), 'utf8')
  check('§7 no entrypoint set suppresses the guide any more (the SDK_ENTRYPOINTS gate is gone)', !/SDK_ENTRYPOINTS/.test(guideSrc))
  const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
  check('§7 the prompt\'s guide line reads the same mount predicate', /isGuideAgentMounted\(\)/.test(prompts))
  if (prevEntry === undefined) delete process.env.MERCURY_ENTRYPOINT
  else process.env.MERCURY_ENTRYPOINT = prevEntry
  if (prevKill === undefined) delete process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS
  else process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS = prevKill
  setIsInteractive(prevInteractive)
}

console.log(failures === 0 ? '\n✓ prove-agent-roster: all green' : `\n✗ prove-agent-roster: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
