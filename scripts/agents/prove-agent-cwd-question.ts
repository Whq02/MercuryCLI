#!/usr/bin/env bun
// gate-watch: src/tools/AgentTool/AgentTool.tsx src/types/permissions.ts src/Tool.ts src/bootstrap/state.ts src/utils/permissions/decision/engine.ts docs/CREW.md
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agent-starting-folder-')))
const work = join(scratch, 'work')
const inside = join(work, 'inside')
const outside = join(scratch, 'outside')
for (const dir of [inside, outside]) mkdirSync(dir, { recursive: true })
const state = await import('../../src/bootstrap/state.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AgentTool, agentCwdQuestion, resolveAgentCwd, inputSchema } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
state.setOriginalCwd(work)
state.setCwdState(work)
let failed = 0
let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const context = getEmptyToolPermissionContext()
try {
  const question = agentCwdQuestion(outside, context)
  check('an outside launch raises ordinary permission with its path', question?.behavior === 'ask' && question.message.includes(outside) && question.message.includes('starting folder'))
  check('the ask does not suggest adding a second root', !JSON.stringify(question).includes('addDirectories'))
  check('an inside launch needs no folder permission', agentCwdQuestion(inside, context) === null)
  check('path resolution never repeats a folder refusal after approval', resolveAgentCwd(outside, context) === outside)
  check('resolving a launch does not grant a second root', agentCwdQuestion(outside, context)?.behavior === 'ask')
  check('a missing folder reaches the typed validation, not a permission ask', agentCwdQuestion(join(work, 'missing'), context) === null)
  check('a relative path reaches typed validation, not a permission ask', agentCwdQuestion('inside', context) === null)
  for (const mode of ['default', 'implement', 'sovereign']) {
    const permission = { ...context, mode }
    const seat = { getAppState: () => ({ toolPermissionContext: permission }), abortController: new AbortController(), options: {} }
    const input = { description: 'probe', prompt: 'report directory', cwd: outside }
    const decision = await decideToolPermission(AgentTool, input, seat as never)
    const bypass = mode === 'sovereign'
    check(`${mode}: outside launch ${bypass ? 'proceeds' : 'asks'}`, decision.decision.behavior === (bypass ? 'allow' : 'ask'), decision.decision.behavior)
    const crewmate = await AgentTool.checkPermissions({ ...input, name: 'mate', crew_name: 'crew' }, seat as never)
    check(`${mode}: named crewmate follows the same law`, crewmate.behavior === (bypass ? 'allow' : 'ask'))
  }
  const words = inputSchema().shape.cwd.description ?? ''
  check('the parameter names the child starting folder and worktree', words.includes('one starting folder') && words.includes("isolation 'worktree'"))
  const docs = readFileSync(join(ROOT, 'docs/CREW.md'), 'utf8').replace(/\s+/g, ' ')
  check('the crew docs state ordinary permission and the child root', docs.includes('asks for ordinary permission') && docs.includes('own single starting folder'))
} finally {
  state.setOriginalCwd(ROOT)
  state.setCwdState(ROOT)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`agent-starting-folder: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
