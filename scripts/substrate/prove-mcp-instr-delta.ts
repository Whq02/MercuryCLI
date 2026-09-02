#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-mcp-instr-delta.ts
//  PROOF: the MCP-instructions DELTA path is default-ON (the cache-
//  boundary fix — the MED class).
//
//  Why this matters: when the delta gate is OFF, prompts.ts announces MCP
//  server instructions via its ONLY live DANGEROUS_uncachedSystemPromptSection
//  (rebuilt every turn) — a late MCP connect/disconnect busts the whole prompt
//  cache from that section on. The delta path instead announces instructions
//  once, as persisted `mcp_instructions_delta` attachments diffed against
//  conversation history, keeping the system prompt byte-stable.
//
//  Asserts:
//   1. gate polarity — stamped build ⇒ default ON; the retired foreign knob
//      falsy ⇒ OFF even on fork (opt-out preserved); truthy ⇒ ON anywhere;
//      bare-stamp default unchanged (byte-identical without it).
//   2. the pure diff (getMcpInstructionsDelta) — announces new servers once,
//      tracks history via prior attachments, emits removals on disconnect,
//      merges client-side blocks, and returns null when nothing changed.
//   3. wiring (structural) — prompts.ts still guards its uncached section on
//      this gate, and attachments.ts still guards the delta producer on it,
//      so the flip actually moves the announcement channel.
//   4. ONE CARRIER (FN-020 row 2) — with the delta on, the system prompt built
//      with instruction-bearing servers is byte-identical to the one built
//      with none (the section resolves null; no second copy rides every
//      request, and a server connecting or dropping can no longer move the
//      org-scoped cached block), while the persisted row carries the
//      section's exact text once.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../../src/utils/mcpInstructionsDelta.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' mcp-instructions delta — default proof')
console.log('============================================================')

const repo = join(import.meta.dir, '..', '..')

section('1. gate polarity')
{
  // The compat-era env opt-out retired with the compat wave: the gate is
  // unconditionally ON — a Mercury ruling, not an experiment, and
  // stamp-independent by construction.
  check('gate is unconditionally ON (env seam retired)', isMcpInstructionsDeltaEnabled() === true)

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

  // Fresh conversation, one server with instructions ⇒ announced.
  const d1 = getMcpInstructionsDelta([connected('alpha', 'use tool X first')], [] as never[], [])
  check('new server announced', d1 !== null && d1.addedNames.join() === 'alpha')
  check('announce block carries the instructions', d1 !== null && /## alpha\nuse tool X first/.test(d1.addedBlocks[0] ?? ''))

  // Already announced in history ⇒ no re-announce (null).
  const d2 = getMcpInstructionsDelta(
    [connected('alpha', 'use tool X first')],
    [deltaMsg(['alpha'], [])] as never[],
    [],
  )
  check('already-announced server not re-announced', d2 === null)

  // Announced server gone ⇒ removed.
  const d3 = getMcpInstructionsDelta([], [deltaMsg(['alpha'], [])] as never[], [])
  check('disconnected server emits removal', d3 !== null && d3.removedNames.join() === 'alpha')

  // Client-side instruction block for a connected server merges/announces.
  const d4 = getMcpInstructionsDelta(
    [connected('beta')],
    [] as never[],
    [{ serverName: 'beta', block: 'client-side context' }],
  )
  check('client-side block announced for connected server', d4 !== null && d4.addedNames.join() === 'beta')
  check('client-side block rendered under the server header', d4 !== null && /## beta\nclient-side context/.test(d4.addedBlocks[0] ?? ''))

  // No instructions anywhere ⇒ null (no churn).
  const d5 = getMcpInstructionsDelta([connected('gamma')], [] as never[], [])
  check('server without instructions ⇒ null', d5 === null)
}

section('3. wiring (structural) — the gate still guards both channels')
{
  const prompts = readFileSync(join(repo, 'src/constants/prompts.ts'), 'utf8')
  const uncachedBlock = prompts.slice(prompts.indexOf('DANGEROUS_uncachedSystemPromptSection('), prompts.indexOf('DANGEROUS_uncachedSystemPromptSection(') + 900)
  check(
    'prompts.ts mcp_instructions section is gate-guarded: null with the delta on, the uncached builder only with it off (FN-020 row 2)',
    /'mcp_instructions',[\s\S]{0,800}?\(\) => \(isMcpInstructionsDeltaEnabled\(\) \? null : buildMcpInstructionsSection\(mcpClients \?\? \[\]\)\),/.test(uncachedBlock),
  )
  // R3 module-scoped read: the attachments implementation is
  // splitting into owned submodules; these invariants are module-scoped, so
  // read the barrel + every submodule as one text.
  const attachments = readFileSync(join(repo, 'src/utils/attachments.ts'), 'utf8') + readdirSync(join(repo, 'src/utils/attachments')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(repo, 'src/utils/attachments', f), 'utf8')).join('\n')
  check(
    'attachments.ts registers the mcp_instructions_delta producer',
    /maybe\('mcp_instructions_delta'/.test(attachments),
  )
  const producer = readFileSync(join(repo, 'src/utils/mcpInstructionsDelta.ts'), 'utf8')
  check(
    'gate is env-free and unconditionally ON (the compat-era override retired with the compat wave)',
    (() => {
      const fn = producer.slice(producer.indexOf('export function isMcpInstructionsDeltaEnabled'), producer.indexOf('}', producer.indexOf('export function isMcpInstructionsDeltaEnabled')) + 1)
      return fn.includes('return true') && !fn.includes('process.env') && !fn.includes('isEnvTruthy') && !fn.includes('getFeatureValue_CACHED_MAY_BE_STALE')
    })(),
  )
}

section('4. ONE CARRIER (FN-020 row 2) — the system prompt is byte-identical with or without instruction-bearing servers; the row carries the section\'s exact text')
{
  // Hermetic home + cwd BEFORE the prompt module loads (module-load env reads).
  const home = mkdtempSync(join(tmpdir(), 'mcp-instr-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-instr-cwd-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-proof-mcp-instr'
  process.chdir(cwd)
  const prompts = await import('../../src/constants/prompts.ts')
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const tools = ['Bash', 'Read', 'Edit', 'Glob', 'Grep'].map(name => ({ name })) as never
  const alpha = { type: 'connected', name: 'alpha', instructions: 'use tool X first' } as never
  const beta = { type: 'connected', name: 'beta', instructions: 'never call Y twice' } as never
  const withServers = (await prompts.getSystemPrompt(tools, 'claude-sonnet-5', undefined, [alpha, beta])).join('\n\n')
  const without = (await prompts.getSystemPrompt(tools, 'claude-sonnet-5', undefined, [])).join('\n\n')
  check('the system prompt with two instruction-bearing servers is byte-identical to the one with none', withServers === without, `${withServers.length} vs ${without.length}`)
  check('…and spells no MCP Server Instructions block (the second copy is gone)', !withServers.includes('# MCP Server Instructions') && !withServers.includes('use tool X first'))
  // The section's text, carried verbatim as the oracle (the builder is module-private).
  const oracle = `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## alpha\nuse tool X first\n\n## beta\nnever call Y twice`
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
