#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'whole-tool-rules-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolAlwaysAllowedRule, getDenyRuleForTool, getAskRuleForTool } = await import('../../src/utils/permissions/decision/rules.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const base = getEmptyToolPermissionContext()
type Tool = { name: string; mcpInfo?: { serverName: string; toolName: string } }
const allowed = (rules: string[], tool: Tool): string | null =>
  toolAlwaysAllowedRule({ ...base, alwaysAllowRules: { cliArg: rules } }, tool as never)?.ruleValue.toolName ?? null
const denied = (rules: string[], tool: Tool): string | null =>
  getDenyRuleForTool({ ...base, alwaysDenyRules: { cliArg: rules } }, tool as never)?.ruleValue.toolName ?? null
const asked = (rules: string[], tool: Tool): string | null =>
  getAskRuleForTool({ ...base, alwaysAskRules: { cliArg: rules } }, tool as never)?.ruleValue.toolName ?? null

console.log('the whole-tool ladder')
check('a rule naming the tool matches it', allowed(['Read'], { name: 'Read' }) === 'Read')
check('a rule naming another tool does not', allowed(['Read'], { name: 'Edit' }) === null)
check('a rule with content never matches the whole tool', allowed(['Bash(ls *)'], { name: 'Bash' }) === null && denied(['Bash(ls *)'], { name: 'Bash' }) === null)
check('the first matching rule in table order answers', denied(['Edit', 'Read', 'Read'], { name: 'Read' }) === 'Read')
check('an inherited name matches through the inherits table', denied(['SendMessage'], { name: 'ResumeAgent' }) === 'SendMessage')
check('inheritance runs one way only', denied(['ResumeAgent'], { name: 'SendMessage' }) === null)
check('the LSP family selector matches an LSP tool', asked(['LSP'], { name: 'LspRead' }) === 'LSP')
check('the LSP family selector matches no other tool', asked(['LSP'], { name: 'Read' }) === null)

console.log('the MCP server rules')
const read = { name: 'mcp__srv__read', mcpInfo: { serverName: 'srv', toolName: 'read' } }
check('a server-wide rule matches every tool of the server', allowed(['mcp__srv'], read) === 'mcp__srv')
check('a server wildcard rule matches every tool of the server', allowed(['mcp__srv__*'], read) === 'mcp__srv__*')
check('a rule naming one tool of the server matches that tool through its qualified name', allowed(['mcp__srv__read'], read) === 'mcp__srv__read')
check('a rule naming another tool of the server does not match', allowed(['mcp__srv__write'], read) === null)
check('a rule for another server does not match', allowed(['mcp__other'], read) === null && allowed(['mcp__other__*'], read) === null)
check('a qualified name without mcpInfo is matched by its spelling alone', allowed(['mcp__srv'], { name: 'mcp__srv__read' }) === 'mcp__srv')
check('the qualified name is built from mcpInfo, not the bare name', allowed(['mcp__srv'], { name: 'read', mcpInfo: { serverName: 'srv', toolName: 'read' } }) === 'mcp__srv')
check('a server-wide rule does not match a builtin tool', allowed(['mcp__srv'], { name: 'Read' }) === null)

console.log(failures ? `FAIL whole-tool rule matching: ${failures} failures` : 'PASS whole-tool rule matching')
process.exit(failures ? 1 : 0)
