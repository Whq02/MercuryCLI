import { mock, spyOn } from 'bun:test'
import { deepStrictEqual, ok } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ParsedPowerShellCommand } from '../../src/permissions/rules/decision/commandAnalysis.js'

const scratch = mkdtempSync(path.join(tmpdir(), 'powershell-named-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
process.on('exit', () => {
  Object.defineProperty(process, 'platform', platform)
  rmSync(scratch, { recursive: true, force: true })
})
if (process.platform !== 'win32') {
  const { win32, posix } = path
  const drive = (word: string): boolean => /^[A-Za-z]:[\\/]/.test(word)
  mock.module('node:path', () => ({
    ...path,
    resolve: (...words: string[]) => (words.some(drive) ? win32 : posix).resolve(...words),
    dirname: (word: string) => (drive(word) ? win32 : posix).dirname(word),
    isAbsolute: (word: string) => (drive(word) ? win32 : posix).isAbsolute(word),
  }))
}

const file = 'C:\\denied\\x.txt'
const denied = [
  `Set-Content ${file} v`, `Set-Content -Path ${file} -Value v`, `Set-Content -LiteralPath ${file} -Value v`,
  `Get-Content ${file}`, `Get-Content -Path ${file}`, `Get-Content -LiteralPath ${file}`,
  `Remove-Item ${file}`, `Remove-Item -Path ${file}`, `Remove-Item -LiteralPath ${file}`, `Remove-Item -Recurse ${file}`,
  'Copy-Item notes.txt C:\\denied\\copy.txt',
  'Remove-Item -Path C:\\out -Recurse -Force', 'Remove-Item -Recurse -Force C:\\out',
]
const reads = ['Get-Content notes.txt', 'Get-Content -Path notes.txt']
const variable = 'ConvertTo-Json $env:USERNAME'
const { pinnedCommandAnalysis } = await import('../../src/permissions/rules/decision/commandAnalysis.js')
const { getCachedPowerShellPath } = await import('../../src/platform/shell/powershellDetection.js')
const native = await getCachedPowerShellPath() !== null
const parses = new Map<string, ParsedPowerShellCommand>()
for (const command of [...denied, ...reads, variable]) {
  const [name, ...args] = command.split(' ')
  const elementTypes = command.split(' ').map(word => word.startsWith('-') ? 'Parameter' : word.startsWith('$') ? 'Variable' : 'StringConstant')
  const parsed: ParsedPowerShellCommand = native ? await pinnedCommandAnalysis.parsePowerShellCommand(command) : {
    valid: true, errors: [], hasStopParsing: false, originalCommand: command,
    variables: command === variable ? [{ path: 'env:USERNAME', splatted: false }] : [],
    statements: [{ statementType: 'PipelineAst', text: command, redirections: [], nestedCommands: [], commands: [{
      name: name!, args, text: command, nameType: 'cmdlet', elementType: 'CommandAst', elementTypes,
    }] }],
  }
  ok(parsed.valid, `Fix the PowerShell parser for ${command}: ${JSON.stringify(parsed.errors)}`)
  deepStrictEqual(parsed.statements[0]?.commands[0]?.elementTypes, elementTypes, `Keep the command name before the argument kinds in the PowerShell parser for ${command}`)
  parses.set(command, parsed)
}
spyOn(pinnedCommandAnalysis, 'parsePowerShellCommand').mockImplementation(async (command: string) => {
  const parsed = parses.get(command)
  ok(parsed, `Add the parse for ${command} to the named-arguments proof`)
  return parsed
})

Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
const { getPlatform } = await import('../../src/platform/environment/platform.js')
getPlatform.cache.set(undefined, 'windows')
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { setOriginalCwd, setProjectRoot, setCwdState } = await import('../../src/boot/process-state/processState.js')
const project = 'C:\\src\\project'
setOriginalCwd(project)
setProjectRoot(project)
setCwdState(project)
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { PowerShellTool } = await import('../../src/tools/powershell/PowerShellTool.js')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.js')
let failures = 0
for (const mode of ['default', 'implement', 'flow', 'sovereign'] as const) {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { userSettings: ['Edit(//C/denied/**)', 'Read(//C/denied/**)'] } }
  const context = { getAppState: () => ({ toolPermissionContext, tasks: {}, sessionHooks: new Map() }), setAppState() {}, abortController: new AbortController(), options: { tools: [PowerShellTool] }, messages: [] } as never
  for (const command of mode === 'default' ? [...denied, ...reads, variable] : denied) {
    const { decision } = await decideToolPermissionWithModes(PowerShellTool as never, { command }, context, { message: { id: 'named-args' } } as never, 'named-args')
    const expected = command === variable ? 'ask' : reads.includes(command) ? 'allow' : 'deny'
    if (decision.behavior !== expected) {
      failures++
      const fix = command === variable ? 'check each argument’s own kind in readOnlyValidation.ts' : 'check every path with its own argument kind in pathValidation.ts'
      console.error(`${mode}: ${command}: expected ${expected}, got ${decision.behavior}; ${fix}`)
    }
  }
}
console.log(`${native ? 'PowerShell parser' : 'Literal AST fixtures'}: ${failures} wrong permission decisions`)
process.exit(failures === 0 ? 0 : 1)
