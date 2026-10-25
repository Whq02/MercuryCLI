import { deepStrictEqual, equal, notStrictEqual, ok } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'powershell-command-sets-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const commands = await import('../../src/utils/powershell/dangerousCmdlets.js')
const { COMMON_ALIASES } = await import('../../src/utils/powershell/parser.js')

const expectedFiles = 'invoke-command start-job start-threadjob register-scheduledjob'.split(' ')
const expectedBlocks = 'invoke-command invoke-expression start-job start-threadjob register-scheduledjob register-engineevent register-objectevent register-wmievent new-pssession enter-pssession'.split(' ')
const expectedModules = 'import-module ipmo install-module save-module update-module install-script save-script'.split(' ')
const expectedCore = 'invoke-command start-job start-threadjob register-scheduledjob invoke-expression register-engineevent register-objectevent register-wmievent new-pssession enter-pssession import-module ipmo install-module save-module update-module install-script save-script invoke-webrequest invoke-restmethod set-alias sal new-alias nal set-variable sv new-variable nv invoke-wmimethod iwmi invoke-cimmethod select-object sort-object group-object where-object measure-object write-output write-host start-sleep format-table format-list format-wide format-custom out-string out-host ipconfig hostname route pwsh powershell cmd bash wsl sh start-process start add-type new-object foreach-object python python3 python2 node deno tsx ruby perl php lua npx bunx ssh'.split(' ')
const expectedNever = [...expectedCore]
for (const [alias, target] of Object.entries(COMMON_ALIASES)) {
  if (expectedCore.includes(target.toLowerCase()) && !expectedNever.includes(alias.toLowerCase())) {
    expectedNever.push(alias.toLowerCase())
  }
}

const rows = [
  [commands.FILEPATH_EXECUTION_CMDLETS, expectedFiles],
  [commands.DANGEROUS_SCRIPT_BLOCK_CMDLETS, expectedBlocks],
  [commands.MODULE_LOADING_CMDLETS, expectedModules],
  [commands.NEVER_SUGGEST, expectedNever],
] as const

for (const [actual, expected] of rows) {
  deepStrictEqual([...actual], expected)
  for (const name of expected) {
    equal(actual.has(name), true)
    equal(actual.has(name.toUpperCase()), name.toUpperCase() === name)
    equal(actual.has(`${name} -FilePath ./example.ps1`), false)
  }
  for (const absent of ['', 'not-a-cmdlet', 'npm run', 'bun run', 'Remove-Item', 'remove-item', 'Get-ChildItem']) {
    equal(actual.has(absent), false)
  }
}

const mutable = [commands.FILEPATH_EXECUTION_CMDLETS, commands.DANGEROUS_SCRIPT_BLOCK_CMDLETS, commands.MODULE_LOADING_CMDLETS]
for (const collection of mutable) {
  for (const other of rows.map(([set]) => set)) {
    if (other !== collection) notStrictEqual(collection, other)
  }
  collection.add('proof-only-command')
  try {
    for (const [other] of rows) {
      equal(other.has('proof-only-command'), other === collection)
    }
  } finally {
    collection.delete('proof-only-command')
  }
}

console.log(`PASS: four ordered command collections, ${expectedNever.length} excluded names, aliases, case and independent membership`)

if (Bun.which('pwsh') === null) {
  console.log('[SKIP] real PowerShell command elements: pwsh is not on PATH')
} else {
  const { pinnedCommandAnalysis: p, getAllCommands } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
  const { powershellToolCheckPermission, powershellToolHasPermission } = await import('../../src/tools/PowerShellTool/powershellPermissions.js')
  let failures = 0
  async function check(label: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run()
      console.log(`[PASS] ${label}`)
    } catch (error) {
      failures++
      console.error(`[FAIL] ${label}: ${error}`)
    }
  }
  const parse = async (command: string) => {
    const parsed = await p.parsePowerShellCommand(command)
    equal(parsed.valid, true, JSON.stringify(parsed.errors))
    return parsed
  }
  await check('one statement emits one named command and its arguments', async () => {
    const parsed = await parse('Get-Content file')
    equal(parsed.statements.length, 1)
    deepStrictEqual(p.getAllCommandNames(parsed), ['get-content'])
    const command = parsed.statements[0]!.commands[0]!
    equal(command.name, 'Get-Content')
    equal(command.nameType, 'cmdlet')
    equal(command.elementType, 'CommandAst')
    deepStrictEqual(command.args, ['file'])
  })
  await check('a two-stage pipeline preserves command order without nested duplicates', async () => {
    const parsed = await parse('Get-Content a | Select-String b')
    equal(parsed.statements.length, 1)
    deepStrictEqual(parsed.statements[0]!.commands.map(c => [c.name, c.args]), [['Get-Content', ['a']], ['Select-String', ['b']]])
    deepStrictEqual(parsed.statements[0]!.nestedCommands, [])
  })
  await check('semicolon-separated commands remain separate statements', async () => {
    const parsed = await parse('git status; rm -r x')
    equal(parsed.statements.length, 2)
    deepStrictEqual(getAllCommands(parsed).map(c => [c.name, c.args]), [['git', ['status']], ['rm', ['-r', 'x']]])
  })
  await check('file redirection retains its target and append/stream operator', async () => {
    for (const operator of ['>', '2>>', '3>', '4>', '5>', '6>', '*>']) {
      const parsed = await parse(`Write-Output hi ${operator} out.txt`)
      deepStrictEqual(p.getFileRedirections(parsed), [{ operator, target: 'out.txt', isMerging: false }])
    }
    const parsed = await parse('Write-Output hi *> $null')
    deepStrictEqual(p.getFileRedirections(parsed), [])
  })
  await check('merging redirections preserve the source and destination streams', async () => {
    for (const operator of ['2>&1', '3>&1', '*>&1']) {
      const parsed = await parse(`Write-Output hi ${operator}`)
      deepStrictEqual(parsed.statements[0]!.redirections, [{ operator, target: '', isMerging: true }])
      deepStrictEqual(p.getFileRedirections(parsed), [])
    }
  })
  await check('nested commands are found in script blocks, subexpressions and control-flow bodies', async () => {
    for (const text of ['& { Remove-Item x }', 'Write-Output $(Remove-Item x)', 'if ($true) { Remove-Item x }', 'foreach ($item in 1,2) { Remove-Item x }']) {
      const parsed = await parse(text)
      const nested = parsed.statements[0]!.nestedCommands
      deepStrictEqual(nested.map(c => [c.name, c.args]), [['Remove-Item', ['x']]])
    }
    const parsed = await parse('& { Write-Output hi > nested.txt }')
    deepStrictEqual(parsed.statements[0]!.nestedCommands[0]!.redirections, [{ operator: '>', target: 'nested.txt', isMerging: false }])
  })
  await check('command names use PowerShell literal values and dynamic names keep their expression text', async () => {
    const quoted = await parse('& "Get-Content" file')
    equal(getAllCommands(quoted)[0]!.name, 'Get-Content')
    const parsed = await parse('& $env:TOOL --flag')
    equal(getAllCommands(parsed)[0]!.name, '$env:TOOL')
    deepStrictEqual(getAllCommands(parsed)[0]!.args, ['--flag'])
    deepStrictEqual(parsed.variables, [{ path: 'env:TOOL', splatted: false }])
    equal((await parse('Write-Output @args')).variables[0]!.splatted, true)
  })
  await check('element classes and colon-bound children survive the program JSON', async () => {
    const parsed = await parse('Write-Output -InputObject:$(Get-Content a)')
    const command = parsed.statements[0]!.commands[0]!
    deepStrictEqual(command.elementTypes, ['StringConstant', 'Parameter'])
    deepStrictEqual(command.children, [[{ type: 'SubExpression', text: '$(Get-Content a)' }]])
  })
  await check('stop-parsing remains detected without parsing its trailing text as another command', async () => {
    const parsed = await parse('git --% status --short')
    equal(parsed.hasStopParsing, true)
    deepStrictEqual(p.getAllCommandNames(parsed), ['git'])
  })
  const permission = (allow: string[] = [], deny: string[] = []) => ({
    ...getEmptyToolPermissionContext(), alwaysAllowRules: { session: allow }, alwaysDenyRules: { session: deny },
  })
  await check('the command-analysis provider exposes a pipeline stage to its allow rule', async () => {
    const parsed = await parse('Get-Content a | Test-Fixture b')
    const stage = getAllCommands(parsed).find(c => c.name === 'Test-Fixture')
    ok(stage)
    equal(powershellToolCheckPermission({ command: stage.text }, permission()).behavior, 'passthrough')
    equal(powershellToolCheckPermission({ command: stage.text }, permission(['PowerShell(Test-Fixture *)'])).behavior, 'allow')
  })
  for (const command of ['Get-Content a | Remove-Item x', '& { Remove-Item x }', 'Write-Output $(Remove-Item x)', 'if ($true) { Remove-Item x }', 'foreach ($item in 1,2) { Remove-Item x }']) {
    await check(`deny rule reaches ${command} even when raw text does not match`, async () => {
      const rules = permission([], ['PowerShell(Remove-Item *)'])
      equal(powershellToolCheckPermission({ command }, rules).behavior, 'passthrough')
      const result = await powershellToolHasPermission({ command }, { getAppState: () => ({ toolPermissionContext: rules }), abortController: new AbortController() } as never)
      equal(result.behavior, 'deny', JSON.stringify(result))
      equal(result.decisionReason?.type, 'rule')
    })
  }
  equal(failures, 0, `${failures} real PowerShell command-element checks failed`)
}
