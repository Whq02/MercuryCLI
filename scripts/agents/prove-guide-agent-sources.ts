#!/usr/bin/env bun
// gate-watch: src/tools/AgentTool/built-in/mercuryGuideAgent.ts src/skills/bundled/provider-apis/SKILL.md
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'guide-sources-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('the guide agent answers provider-API questions from the bundled provider-apis skill')

const { MERCURY_GUIDE_AGENT, isGuideAgentMounted } = await import('../../src/tools/AgentTool/built-in/mercuryGuideAgent.ts')
const { SKILL_TOOL_NAME } = await import('../../src/tools/SkillTool/constants.ts')

const prompt = MERCURY_GUIDE_AGENT.getSystemPrompt!({
  toolUseContext: { options: { commands: [], agentDefinitions: { activeAgents: [] }, mcpClients: [] } },
} as never) as string

const generatedAt = prompt.indexOf("\n\n## The user's current configuration")
const ownWords = generatedAt === -1 ? prompt : prompt.slice(0, generatedAt)
const domains = ownWords.split('\n\n## Identity')[0]!.split('\n').filter(line => /^\d+\. /.test(line))
check('the guide still mounts', isGuideAgentMounted() === true)
check('the prompt names two domains: the harness and the provider APIs', domains.length === 2 && domains[0]!.startsWith("1. Mercury's own surface") && domains[1]!.startsWith('2. The model-provider APIs Mercury drives'), domains.join(' | '))
check("the guide's own words fetch no documentation site (no URL in them)", !/https?:\/\//.test(ownWords), (ownWords.match(/https?:\/\/\S+/g) ?? []).join(' '))
check('the generated knowledge still rides behind the words (the flag table)', generatedAt > 0 && /### Registered environment flags/.test(prompt))
check('provider-API knowledge comes from the bundled provider-apis skill, invoked through the Skill tool', prompt.includes('`provider-apis` skill') && prompt.includes(`through the ${SKILL_TOOL_NAME} tool`))
check('the approach invokes the skill first for provider-API questions', /For provider-API questions, invoke the `provider-apis` skill first/.test(prompt))
check('web search is the last resort, after the skill and the generated knowledge', /Use web search only when neither the skill nor the generated knowledge covers the question/.test(prompt))
check('the feedback line is provider-neutral: /bug for the product, the provider\'s own channels for its outage', /feedback command \(\/bug\); for a provider's own outage or refusal, at that provider's status and support channels/.test(prompt))
check("the guide's tools include the Skill tool", Array.isArray(MERCURY_GUIDE_AGENT.tools) && MERCURY_GUIDE_AGENT.tools.includes(SKILL_TOOL_NAME), JSON.stringify(MERCURY_GUIDE_AGENT.tools))
check('the description names the two domains and the skill, in Mercury\'s words', MERCURY_GUIDE_AGENT.whenToUse.startsWith("Mercury's product guide:") && MERCURY_GUIDE_AGENT.whenToUse.includes('bundled provider-apis skill') && !/SDK/.test(MERCURY_GUIDE_AGENT.whenToUse), MERCURY_GUIDE_AGENT.whenToUse.slice(0, 160))
check('the bundled skill the prompt names exists and covers the chat-completions providers too', existsSync(join(REPO, 'src/skills/bundled/provider-apis/SKILL.md')) && /xAI \(Grok\)/.test(readFileSync(join(REPO, 'src/skills/bundled/provider-apis/SKILL.md'), 'utf8')))

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ GUIDE AGENT SOURCES GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ GUIDE AGENT SOURCES RED (${failures} of ${checks} checks failed)`)
process.exit(1)
