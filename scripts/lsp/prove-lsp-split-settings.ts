import { join } from 'node:path'
import { armScratch, check, cleanup, finish, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-split-settings')
const root = writeProject(scratch, 'project', {})
writeProject(scratch, 'home', { 'settings.json': JSON.stringify({ guardrails: { allow: ['LSP'] }, events: { hooks: { 'tool.before': [{ match: 'LSP', run: 'true' }, { match: '^LSP$', run: 'true' }] } } }) })
const { enterRoot } = await import('../ast-tools/lib/harness.ts')
await enterRoot(root)
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
if (!('LSP_TOOLS' in available)) {
  check('the LSP setting family covers all seven tools without a callable alias', false)
  cleanup(scratch)
  finish('prove-lsp-split-settings')
}
const { LSP_TOOLS } = available
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/Tool.ts')
const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.ts')
const { toolAlwaysAllowedRule, getDenyRuleForTool, getAskRuleForTool } = await import('../../src/utils/permissions/decision/rules.ts')
const { killCapability, restoreCapability, isCapabilityKilled, capabilityKillReason } = await import('../../src/utils/permissions/capabilityGate.ts')
const { matchesPattern } = await import('../../src/utils/hooks/matching.ts')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { lspPermissionNote, lspCliNote, lspHookNote, lspAgentNote } = await import('../../src/services/lsp/toolFamily.ts')
const successors = 'LspRead, LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat and LspRequest'
for (const kind of ['allow', 'deny'] as const) {
  const initialized = await initializeToolPermissionContext({ allowedToolsCli: kind === 'allow' ? ['LSP'] : [], disallowedToolsCli: kind === 'deny' ? ['LSP'] : [], permissionMode: 'default', allowDangerouslySkipPermissions: false })
  check(`CLI ${kind} names all seven successors`, LSP_TOOLS.every(tool => (kind === 'allow' ? toolAlwaysAllowedRule : getDenyRuleForTool)(initialized.toolPermissionContext, tool) !== null))
  check(`CLI ${kind} has the exact startup note`, initialized.warnings.includes(`${kind === 'allow' ? '--allowed-tools' : '--block-tools'} LSP covers ${successors}.`), JSON.stringify(initialized.warnings))
  check(`saved settings ${kind}: permission and both hook notes are emitted at startup`, initialized.warnings.includes(lspPermissionNote('userSettings')) && initialized.warnings.includes(lspHookNote('tool.before', 'LSP', 'userSettings')!) && initialized.warnings.includes(lspHookNote('tool.before', '^LSP$', 'userSettings')!), JSON.stringify(initialized.warnings))
}
const context = { ...getEmptyToolPermissionContext(), alwaysAskRules: { cliArg: ['LSP'] } }
check('tool-wide ask rules retain their floor for all seven', LSP_TOOLS.every(tool => getAskRuleForTool(context, tool)))
const content = { ...getEmptyToolPermissionContext(), alwaysAllowRules: { cliArg: ['LSP(src/**)'] }, alwaysDenyRules: { cliArg: ['LSP(src/**)'] }, alwaysAskRules: { cliArg: ['LSP(src/**)'] } }
check('content rules match none, as before', LSP_TOOLS.every(tool => !toolAlwaysAllowedRule(content, tool) && !getDenyRuleForTool(content, tool) && !getAskRuleForTool(content, tool)))
for (const selector of ['LSP', 'lsp']) {
  killCapability('*', selector)
  check(`${selector} kill covers all seven with its own reason`, LSP_TOOLS.every(tool => isCapabilityKilled(tool.name) && capabilityKillReason(tool.name)?.killPattern === `*:${selector}`))
  restoreCapability('*', selector)
  check(`${selector} restore releases the family kill`, LSP_TOOLS.every(tool => !isCapabilityKilled(tool.name)))
}
check('name and pipe hook matchers cover the family', LSP_TOOLS.every(tool => matchesPattern(tool.name, 'LSP') && matchesPattern(tool.name, 'Edit|LSP')))
check('a regex keeps its regex meaning, not family semantics', LSP_TOOLS.every(tool => !matchesPattern(tool.name, '^LSP$')))
const definition = { source: 'projectSettings' as const, tools: ['LSP'], agentType: 'fixture' }
const resolved = resolveAgentTools(definition, LSP_TOOLS, false, true)
check('agent tools family resolves to exactly all seven', JSON.stringify(resolved.resolvedTools.map(tool => tool.name)) === JSON.stringify(LSP_TOOLS.map(tool => tool.name)))
const denied = resolveAgentTools({ ...definition, tools: ['*'], disallowedTools: ['LSP'] }, LSP_TOOLS, false, true)
check('agent disallowedTools family excludes all seven', denied.resolvedTools.length === 0)
check('a content-qualified family is not an agent-tool alias', resolveAgentTools({ ...definition, tools: ['LSP(src/**)'] }, LSP_TOOLS, false, true).resolvedTools.length === 0)
check('the setting family is never a callable alias', findToolByName(LSP_TOOLS, 'LSP') === undefined)
check('permission note matches N1', lspPermissionNote('projectSettings') === `The permission rule \`LSP\` in projectSettings covers ${successors}; write those names to narrow it.`)
check('hook note matches N1', lspHookNote('tool.before', 'Edit|LSP', 'projectSettings') === `The tool.before hook match \`LSP\` in projectSettings fires for ${successors}; only LspRead's input has an operation field.`)
check('regex hook note matches N1', lspHookNote('tool.before', '^LSP$', 'projectSettings') === `The tool.before hook match \`^LSP$\` in projectSettings matches \`LSP\` but none of ${successors} — add their names to keep it.`)
check('agent note matches N1', lspAgentNote('fixture') === `The agent fixture lists \`LSP\` in its tools; that gives it ${successors}.`)
cleanup(scratch)
finish('prove-lsp-split-settings')
