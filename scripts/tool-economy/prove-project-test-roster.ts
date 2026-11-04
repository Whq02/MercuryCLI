#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'project-test-roster-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_TOOL_SEARCH = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { isDeferredToolFor } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const tools = [TestTool, ToolSearchTool, BashTool]
let failures = 0
function check(label: string, ok: boolean) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
try {
  for (const [model, profile] of [['claude-fable-5-1', true], ['gpt-6-astra', true], ['local/qwen3-32b', true], ['local/qwen3-32b', false]] as const) {
    if (profile) delete process.env.MERCURY_LOCAL_PROMPT_PROFILE
    else process.env.MERCURY_LOCAL_PROMPT_PROFILE = '0'
    const lane = `${model}${profile ? '' : ' (profile off)'}`
    for (const declared of [false, true]) {
      const project = join(root, `${model.replaceAll('/', '-')}-${profile}-${declared}`)
      mkdirSync(project)
      if (declared) writeFileSync(join(project, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }))
      clearToolRosterLatches()
      const messages = [createUserMessage({ content: 'run the tests' })]
      const input = { model, tools, messages, agents: [], latchKey: project, getToolPermissionContext: async () => getEmptyToolPermissionContext() }
      const plan = await runWithCwdOverride(project, () => planToolPayload(input))
      const cloud = !model.startsWith('local/')
      const deferred = cloud || profile || !declared
      check(`${lane} ${declared}: Test is deferred on a cloud route and under the local prompt profile; with the profile off the local lane follows the declared runner`, plan.deferredNames.has('Test') === deferred)
      check(`${lane} ${declared}: discovery uses the same predicate`, runWithCwdOverride(project, () => isDeferredToolFor(TestTool, model)) === deferred)
      if (!deferred) check(`${lane}: Test rides in the named roster without admission`, plan.roster.some(t => t.name === 'Test') && !plan.isDeferredUnadmitted('Test'))
      else if (!declared) {
        writeFileSync(join(project, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }))
        const frozen = await runWithCwdOverride(project, () => planToolPayload(input))
        check(`${lane}: a mid-turn manifest never changes the frozen mark`, frozen.deferredNames.has('Test'))
      }
    }
  }
  delete process.env.MERCURY_LOCAL_PROMPT_PROFILE
} finally { clearToolRosterLatches(); rmSync(root, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-project-test-roster: GREEN')
