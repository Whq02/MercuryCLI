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
check('an inherited name matches through the inherits table', denied(['SendMessage'], { name: 'ResumeCrewmate' }) === 'SendMessage')
check('inheritance runs one way only', denied(['ResumeCrewmate'], { name: 'SendMessage' }) === null)
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

console.log('a server whose name carries a double underscore keeps its own boundary')
{
  const { filterToolsByDenyRules } = await import('../../src/tools.ts')
  const { wholeToolDenyRulesCovering } = await import('../../src/utils/permissions/ruleReason.ts')
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
  const { z } = await import('zod/v4')
  const joined = { name: 'mcp__a__b__c', mcpInfo: { serverName: 'a__b', toolName: 'c' } }
  const sibling = { name: 'mcp__a__b__zzz', mcpInfo: { serverName: 'a__b', toolName: 'zzz' } }
  const plain = { name: 'mcp__a__x', mcpInfo: { serverName: 'a', toolName: 'x' } }
  const plainB = { name: 'mcp__a__b', mcpInfo: { serverName: 'a', toolName: 'b' } }
  check('a rule for server a does not allow a tool of server a__b', allowed(['mcp__a'], joined) === null)
  check('a rule for server a does not deny a tool of server a__b', denied(['mcp__a'], joined) === null)
  check('a rule for server a still covers its own tools', allowed(['mcp__a'], plain) === 'mcp__a' && denied(['mcp__a'], plainB) === 'mcp__a')
  check('mcp__a__b names server a__b whole: every tool of it is covered', denied(['mcp__a__b'], joined) === 'mcp__a__b' && denied(['mcp__a__b'], sibling) === 'mcp__a__b')
  check('mcp__a__b__* names server a__b whole too', asked(['mcp__a__b__*'], joined) === 'mcp__a__b__*' && asked(['mcp__a__b__*'], sibling) === 'mcp__a__b__*')
  check('mcp__a__b still names tool b of server a', denied(['mcp__a__b'], plainB) === 'mcp__a__b' && denied(['mcp__a__b'], plain) === null)
  check('mcp__a__b__c names tool c of server a__b and nothing else', denied(['mcp__a__b__c'], joined) === 'mcp__a__b__c' && denied(['mcp__a__b__c'], sibling) === null)
  check('a rule for server a__ (a trailing separator) covers nothing of a__b', denied(['mcp__a__'], joined) === null)
  const withheld = filterToolsByDenyRules([plain, joined] as never, { ...base, alwaysDenyRules: { cliArg: ['mcp__a'] } } as never).map((tool: { name: string }) => tool.name)
  check('the tool pool withholds the tools of server a and keeps those of a__b', JSON.stringify(withheld) === JSON.stringify(['mcp__a__b__c']), JSON.stringify(withheld))
  const covering = wholeToolDenyRulesCovering({ ...base, alwaysDenyRules: { cliArg: ['mcp__a', 'mcp__a__b', 'mcp__a__b__*', 'mcp__other'] } } as never, joined).map(rule => rule.ruleValue.toolName)
  check('the covering set names only the rules that reach server a__b', JSON.stringify(covering) === JSON.stringify(['mcp__a__b', 'mcp__a__b__*']), JSON.stringify(covering))
  const tool = (shape: typeof joined) => ({ ...shape, inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'passthrough', message: 'no verdict' }) }) as never
  const decideIn = async (mode: string, deny: string[], shape: typeof joined) => {
    const state = { toolPermissionContext: { ...base, mode, isBypassPermissionsModeAvailable: mode === 'sovereign', alwaysDenyRules: { cliArg: deny } } }
    const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
    return (await decideToolPermission(tool(shape), {}, context)).decision.behavior
  }
  check('default: a tool of server a__b under deny mcp__a asks (no rule reaches it)', (await decideIn('default', ['mcp__a'], joined)) === 'ask')
  check('default: a tool of server a__b under deny mcp__a__b is denied', (await decideIn('default', ['mcp__a__b'], joined)) === 'deny')
  check('sovereign asks nothing: a tool of server a__b under deny mcp__a is allowed', (await decideIn('sovereign', ['mcp__a'], joined)) === 'allow')
  check('sovereign asks nothing: a tool of server a__b under deny mcp__a__b is denied, not asked', (await decideIn('sovereign', ['mcp__a__b'], joined)) === 'deny')
}

console.log('a tool named like an object property is looked up without a throw')
{
  const { RULE_INHERITS } = await import('../../src/constants/tools.ts')
  const { wholeToolDenyRulesCovering } = await import('../../src/utils/permissions/ruleReason.ts')
  const words = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']
  check('the inherits table carries no object prototype', Object.getPrototypeOf(RULE_INHERITS) === null)
  check('a prototype word reads as absent from the table', words.every(word => RULE_INHERITS[word] === undefined))
  const context = { ...base, alwaysDenyRules: { cliArg: ['Bash'] }, alwaysAllowRules: { cliArg: ['Read'] }, alwaysAskRules: { cliArg: ['Edit'] } }
  for (const word of words) {
    const shapes: Tool[] = [{ name: word }, { name: `mcp__${word}__${word}`, mcpInfo: { serverName: word, toolName: word } }]
    for (const shape of shapes) {
      let outcome = 'no match'
      try {
        if (getDenyRuleForTool(context, shape as never) !== null || toolAlwaysAllowedRule(context, shape as never) !== null || getAskRuleForTool(context, shape as never) !== null) outcome = 'matched'
        if (wholeToolDenyRulesCovering(context, shape).length > 0) outcome = 'matched'
      } catch (error) {
        outcome = `threw: ${(error as Error).message}`
      }
      check(`${shape.mcpInfo ? 'an MCP' : 'a bare'} tool named ${word} is looked up and matches no rule`, outcome === 'no match', outcome)
    }
  }
  check('the inherited name still matches through the table', denied(['SendMessage'], { name: 'ResumeCrewmate' }) === 'SendMessage')
}

console.log(failures ? `FAIL whole-tool rule matching: ${failures} failures` : 'PASS whole-tool rule matching')
process.exit(failures ? 1 : 0)
