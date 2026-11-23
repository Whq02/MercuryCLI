#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../../src/integrations/mcp/mcpInstructionsDelta.ts'

const DELTA_HINT = 'change getMcpInstructionsDelta or isMcpInstructionsDeltaEnabled in src/integrations/mcp/mcpInstructionsDelta.ts (sections 1 and 2); for section 4 also getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts (no MCP instructions in the system prompt) and normalizeAttachmentForAPI in src/engine/messages/attachmentText.ts (the row text)'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : (detail ? detail + ' — ' : '') + DELTA_HINT
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' mcp-instructions delta — default proof')
console.log('============================================================')


section('1. gate polarity')
{
  check('gate is unconditionally ON (no env seam)', isMcpInstructionsDeltaEnabled() === true)

  const savedMacro = (globalThis as Record<string, unknown>).MACRO
  delete (globalThis as Record<string, unknown>).MACRO
  const bareStampDefault = isMcpInstructionsDeltaEnabled()
  ;(globalThis as Record<string, unknown>).MACRO = savedMacro
  check('no MACRO ⇒ STILL ON (stamp-independence)', bareStampDefault === true)
}

section('2. the pure diff — announce/track/remove/merge')
{
  type AnyMsg = { type: string; attachment?: { type: string; addedNames: string[]; removedNames: string[] } }
  const connected = (name: string, instructions?: string) =>
    ({ type: 'connected', name, instructions }) as never
  const deltaMsg = (added: string[], removed: string[]): AnyMsg => ({
    type: 'attachment',
    attachment: { type: 'mcp_instructions_delta', addedNames: added, removedNames: removed },
  })

  const d1 = getMcpInstructionsDelta([connected('alpha', 'use tool X first')], [] as never[], [])
  check('new server announced', d1 !== null && d1.addedNames.join() === 'alpha')
  check('announce block carries the instructions', d1 !== null && /## alpha\nuse tool X first/.test(d1.addedBlocks[0] ?? ''))

  const d2 = getMcpInstructionsDelta(
    [connected('alpha', 'use tool X first')],
    [deltaMsg(['alpha'], [])] as never[],
    [],
  )
  check('already-announced server not re-announced', d2 === null)

  const d3 = getMcpInstructionsDelta([], [deltaMsg(['alpha'], [])] as never[], [])
  check('disconnected server emits removal', d3 !== null && d3.removedNames.join() === 'alpha')

  const d4 = getMcpInstructionsDelta(
    [connected('beta')],
    [] as never[],
    [{ serverName: 'beta', block: 'client-side context' }],
  )
  check('client-side block announced for connected server', d4 !== null && d4.addedNames.join() === 'beta')
  check('client-side block rendered under the server header', d4 !== null && /## beta\nclient-side context/.test(d4.addedBlocks[0] ?? ''))

  const d5 = getMcpInstructionsDelta([connected('gamma')], [] as never[], [])
  check('server without instructions ⇒ null', d5 === null)
}


section('4. ONE CARRIER (FN-020 row 2) — the system prompt is byte-identical with or without instruction-bearing servers; the row carries the section\'s exact text')
{
  const home = mkdtempSync(join(tmpdir(), 'mcp-instr-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-instr-cwd-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-proof-mcp-instr'
  process.chdir(cwd)
  const prompts = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.ts')
  const tools = ['Bash', 'Read', 'Edit', 'Glob', 'Grep'].map(name => ({ name })) as never
  const alpha = { type: 'connected', name: 'alpha', instructions: 'use tool X first' } as never
  const beta = { type: 'connected', name: 'beta', instructions: 'never call Y twice' } as never
  const withServers = (await prompts.getSystemPrompt(tools, 'claude-sonnet-5', [alpha, beta])).join('\n\n')
  const without = (await prompts.getSystemPrompt(tools, 'claude-sonnet-5', [])).join('\n\n')
  check('the system prompt with two instruction-bearing servers is byte-identical to the one with none', withServers === without, `${withServers.length} vs ${without.length}`)
  check('…and spells no MCP server instructions block (the second copy is gone)', !withServers.includes('# MCP server instructions') && !withServers.includes('use tool X first'))
  const oracle = `# MCP server instructions\n\nEach server below says how its tools and resources are used:\n\n## alpha\nuse tool X first\n\n## beta\nnever call Y twice`
  const delta = getMcpInstructionsDelta([alpha, beta], [] as never[], [])
  const rendered = delta ? normalizeAttachmentForAPI({ type: 'mcp_instructions_delta', ...delta } as never) : []
  const content = rendered[0]?.message.content
  check('the persisted row carries the section\'s exact text once (one carrier, the same information)', rendered.length === 1 && typeof content === 'string' && content === `<system-reminder>\n${oracle}\n</system-reminder>`)
  const before = Buffer.byteLength(oracle, 'utf8')
  console.log(`  BEFORE: ${before} bytes of instructions in the system prompt on EVERY request, plus the identical row in history; AFTER: 0 in the system prompt, the row alone`)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` RESULT: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
