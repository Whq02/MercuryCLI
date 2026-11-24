#!/usr/bin/env bun
// gate-watch: src/tools/crewmate/CrewmateTool.tsx src/permissions/rules/permissions.ts src/tools/kit/tool.ts src/boot/process-state/processState.ts src/permissions/rules/decision/engine.ts docs/CREW.md
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
const state = await import('../../src/boot/process-state/processState.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { CrewmateTool, crewmateCwdQuestion, resolveCrewmateCwd, inputSchema } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { decideToolPermission } = await import('../../src/permissions/rules/decision/engine.ts')
state.setOriginalCwd(work)
state.setCwdState(work)
let failed = 0
let passed = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const context = getEmptyToolPermissionContext()
try {
  const question = crewmateCwdQuestion(outside, context)
  check('an outside launch raises ordinary permission with its path', question?.behavior === 'ask' && question.message.includes(outside) && question.message.includes('starting folder'), '', 'fix agentCwdQuestion in src/tools/crewmate/call/cwd.ts to return an ask whose message names the outside path and says starting folder')
  check('the ask does not suggest adding a second root', !JSON.stringify(question).includes('addDirectories'), '', 'remove the add-directories suggestion from the ask built by agentCwdQuestion in src/tools/crewmate/call/cwd.ts')
  check('an inside launch needs no folder permission', crewmateCwdQuestion(inside, context) === null, '', 'fix agentCwdQuestion in src/tools/crewmate/call/cwd.ts to return null for a folder inside the session folder')
  check('path resolution never repeats a folder refusal after approval', resolveCrewmateCwd(outside, context) === outside, '', 'fix resolveAgentCwd in src/tools/crewmate/call/cwd.ts to return the outside path without a second folder refusal')
  check('resolving a launch does not grant a second root', crewmateCwdQuestion(outside, context)?.behavior === 'ask', '', 'agentCwdQuestion in src/tools/crewmate/call/cwd.ts must keep asking after resolveAgentCwd; resolving must not add a root')
  check('a missing folder reaches the typed validation, not a permission ask', crewmateCwdQuestion(join(work, 'missing'), context) === null, '', 'fix agentCwdQuestion in src/tools/crewmate/call/cwd.ts to return null for a missing folder so the typed validation reports it')
  check('a relative path reaches typed validation, not a permission ask', crewmateCwdQuestion('inside', context) === null, '', 'fix agentCwdQuestion in src/tools/crewmate/call/cwd.ts to return null for a relative path so the typed validation reports it')
  for (const mode of ['default', 'implement', 'sovereign']) {
    const permission = { ...context, mode }
    const seat = { getAppState: () => ({ toolPermissionContext: permission }), abortController: new AbortController(), options: {} }
    const input = { description: 'probe', prompt: 'report directory', cwd: outside }
    const decision = await decideToolPermission(CrewmateTool, input, seat as never)
    const bypass = mode === 'sovereign'
    check(`${mode}: outside launch ${bypass ? 'proceeds' : 'asks'}`, decision.decision.behavior === (bypass ? 'allow' : 'ask'), decision.decision.behavior, 'fix checkPermissions of AgentTool in src/tools/crewmate/CrewmateTool.tsx (agentCwdQuestion) or the mode handling in decideToolPermission, src/permissions/rules/decision/engine.ts')
    const crewmate = await CrewmateTool.checkPermissions({ ...input, name: 'mate' }, seat as never)
    check(`${mode}: named crewmate follows the same law`, crewmate.behavior === (bypass ? 'allow' : 'ask'), '', 'fix checkPermissions of AgentTool in src/tools/crewmate/CrewmateTool.tsx so a named crewmate gets the same cwd question as an unnamed launch')
  }
  const words = inputSchema().shape.cwd.description ?? ''
  check('the parameter names the child starting folder, the permission bound and the worktree', words.includes('Absolute starting directory') && words.includes("Starting outside the session's folder asks for permission") && words.includes('with isolation, its repository supplies the worktree'), '', 'restore the cwd description of inputSchema in src/tools/crewmate/call/schema.ts')
} finally {
  state.setOriginalCwd(ROOT)
  state.setCwdState(ROOT)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`agent-starting-folder: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
