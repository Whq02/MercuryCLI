import { deepStrictEqual, equal, notStrictEqual } from 'node:assert/strict'

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
