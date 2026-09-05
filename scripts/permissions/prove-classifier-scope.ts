#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'classifier-scope-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

await import('../../src/utils/permissions/decision/wrapper.ts')
const yolo = await import('../../src/utils/permissions/yoloClassifier.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const GAME_TASK = 'Build the hunter enemy for the voxel game and wire its spawn into the level.'
const CHILD_BRIEF = 'Research how the parser reports errors. No code changes or runtime invocations — a read-only investigation; report findings only.'
const DIAGNOSIS = 'Leave the game for now. Diagnose why the offline parser test fails.'
const EVAL_CODE = 'parse("fn main() {}")'

const user = (text: string): unknown => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistantToolUse = (name: string, input: Record<string, unknown>, id: string): unknown => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, text: string): unknown => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
})

const evalTool = { name: 'REPL', toAutoClassifierInput: (input: { code?: string }) => input.code ?? '' }
const tools = [AgentTool, evalTool] as never

const messages = [
  user(GAME_TASK),
  assistantToolUse('Agent', { description: 'research the parser', prompt: CHILD_BRIEF, subagent_type: 'Explore' }, 'toolu_scope_agent'),
  toolResult('toolu_scope_agent', 'Findings: the parser reports errors through a result object.'),
  user(DIAGNOSIS),
] as never

const transcript = yolo.buildTranscriptForClassifier(messages, tools)
const action = yolo.formatActionForClassifier('REPL', { code: EVAL_CODE })
console.log(`  transcript:\n${transcript.split('\n').map(l => `    │ ${l}`).join('\n')}`)

section("§1 a child's briefing is context — never this session's rules")
{
  const agentLine = transcript.split('\n').find(l => l.startsWith('Agent ')) ?? ''
  check('the Agent call projects into the transcript', agentLine !== '', transcript)
  check("the line leads with the sub-agent briefing words BEFORE the child's prompt", /separate sub-agent/.test(agentLine) && agentLine.includes('sub-agent') && agentLine.indexOf('sub-agent') < agentLine.indexOf('No code changes'), agentLine)
  check('the words say the briefing binds that sub-agent alone, never this session', /bind(s)? that sub-agent (alone|only)/.test(agentLine) && /never this session/.test(agentLine), agentLine)
  check("the child's prompt still rides as context (the judge can see what was delegated)", agentLine.includes('No code changes or runtime invocations'), agentLine)
  check('the agent type still rides the line', agentLine.includes('Explore'), agentLine)
}

section("§2 the operator's latest request is the task the judge weighs")
{
  const lines = transcript.split('\n').filter(l => l !== '')
  const gameLine = lines.find(l => l.includes(GAME_TASK)) ?? ''
  const diagnosisLine = lines.find(l => l.includes(DIAGNOSIS)) ?? ''
  check('the earlier prompt is plain history (User: …)', gameLine.startsWith('User: '), gameLine)
  check('the latest prompt is marked as the latest request — the current task', /^User \(latest request/.test(diagnosisLine), diagnosisLine)
  check('the latest request is the LAST user line, after the delegation', lines.indexOf(diagnosisLine) > lines.findIndex(l => l.startsWith('Agent ')), j(lines))
  check('exactly one line wears the latest-request mark', lines.filter(l => l.startsWith('User (latest request')).length === 1, j(lines))
  const actionInput = action.content[0]?.input as { code?: string } | undefined
  check('the action projects as the tool name and its code', action.role === 'assistant' && action.content[0]?.name === 'REPL' && actionInput?.code === EVAL_CODE, j(action))
}

section('§3 the system prompt tells the judge both laws')
{
  const asset = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'permissions', 'auto-mode-classifier-prompts', 'auto_mode_system_prompt.txt'), 'utf8')
  check('the prompt says the latest request is the task the agent works on now', /latest request/.test(asset) && /(task|work)[^.\n]*(now|current)/.test(asset), asset.slice(0, 300))
  check("the prompt says a sub-agent's briefing binds that sub-agent alone — not this session", /sub-agent/.test(asset) && /bind/.test(asset) && /alone|only/.test(asset), asset.slice(0, 300))
  check('the prompt weighs an action against what the latest request asks for', /latest request/.test(asset.split('## Classification process')[1] ?? ''), asset.split('## Classification process')[1]?.slice(0, 400) ?? '')
  const assembled = yolo.buildDefaultExternalSystemPrompt()
  check('the assembled prompt carries both (the asset is what ships)', /latest request/.test(assembled) && /sub-agent/.test(assembled))
  check('the tool-reporting sentinel stays exactly once (the XML path replaces it)', assembled.split('Use the classify_result tool to report your classification.').length === 2)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CLASSIFIER-SCOPE PROOFS PASS')
else console.log(`❌ ${failures} CLASSIFIER-SCOPE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
