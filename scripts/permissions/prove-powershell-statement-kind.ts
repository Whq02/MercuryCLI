import { equal } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedPowerShellCommand } from '../../src/permissions/rules/decision/commandAnalysis.js'

const home = mkdtempSync(join(tmpdir(), 'powershell-statement-kind-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { isProvablySafeStatement } = await import('../../src/tools/powershell/readOnlyValidation.js')
const statement: ParsedPowerShellCommand['statements'][number] = {
  statementType: 'PipelineAst', text: 'Test-Fixture b', commands: [{
    name: 'Test-Fixture', text: 'Test-Fixture b', nameType: 'cmdlet', args: ['b'], elementType: 'CommandAst',
  }], nestedCommands: [], redirections: [],
}
equal(isProvablySafeStatement(statement), true, 'the statement gate accepts the parser’s PipelineAst label: fix isProvablySafeStatement in src/tools/powershell/readOnlyValidation.ts')
equal(isProvablySafeStatement({ ...statement, statementType: 'IfStatementAst' }), false, 'a control-flow statement (IfStatementAst) must be refused: fix isProvablySafeStatement in src/tools/powershell/readOnlyValidation.ts')
equal(isProvablySafeStatement({ ...statement, commands: [] }), false, 'a statement with no commands must be refused: fix isProvablySafeStatement in src/tools/powershell/readOnlyValidation.ts')
equal(isProvablySafeStatement({ ...statement, nestedCommands: statement.commands }), false, 'a statement with nested commands must be refused: fix isProvablySafeStatement in src/tools/powershell/readOnlyValidation.ts')
console.log('[PASS] the statement gate uses the parser label and keeps its empty/nested/control-flow refusals')

if (Bun.which('pwsh') === null) {
  console.log('[SKIP] real PowerShell statement-kind permission check: pwsh is not on PATH')
} else {
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
  const { powershellToolHasPermission } = await import('../../src/tools/powershell/powershellPermissions.js')
  const command = 'Get-Content a | Test-Fixture b'
  for (const allow of [false, true]) {
    const rules = { ...getEmptyToolPermissionContext(), alwaysAllowRules: { session: allow ? ['PowerShell(Test-Fixture *)'] : [] } }
    const result = await powershellToolHasPermission({ command }, { getAppState: () => ({ toolPermissionContext: rules }), abortController: new AbortController() } as never)
    equal(result.behavior, allow ? 'allow' : 'passthrough', `${JSON.stringify(result)} · fix powershellToolHasPermission in src/tools/powershell/powershellPermissions.ts: a pipeline is allowed only when its non-allowlisted stage has an allow rule`)
  }
  console.log('[PASS] the pipeline is allowed only when its non-allowlisted stage has an allow rule')
}
