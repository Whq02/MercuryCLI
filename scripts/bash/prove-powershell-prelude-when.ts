#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { createPowerShellProvider, UTF8_OUTPUT_PRELUDE } = await import('../../src/platform/shell/powershellProvider.js')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const provider = createPowerShellProvider('pwsh')
const CLEAR_MARKER = 'Set-Location -LiteralPath .'

console.log('============================================================')
console.log(' PowerShell location-history prelude — only when needed')
console.log('============================================================')

const plainCommands = [
  'Write-Output 1',
  'Get-ChildItem',
  'git status',
  'Get-Location',
  '(Get-Location).Path',
  'Get-Content foo.txt -Encoding utf8',
  'git status && git diff',
  'node -e "console.log(1)" 2>&1',
  'Get-ChildItem .',
  'Write-Output "hello. world"',
  'my-cd-tool --status',
  'Get-Content script.ps1',
  'git diff . "src/a.ts"',
]

for (const command of plainCommands) {
  const built = await provider.buildExecCommand(command, { id: 'plain-check' })
  const hasClear = built.commandString.includes(CLEAR_MARKER)
  const hasPlain = built.commandString.includes("$PSStyle.OutputRendering = 'PlainText'")
  const hasUtf8 = built.commandString.includes(UTF8_OUTPUT_PRELUDE)
  const cmdAt = built.commandString.indexOf(`\n${command}\n`)
  const trailerAt = built.commandString.indexOf('\n; $host.SetShouldExit($mc)')
  check(
    `plain command omits location-history prelude: ${command}`,
    !hasClear && hasPlain && hasUtf8 && cmdAt !== -1 && trailerAt > cmdAt,
    `hasClear=${hasClear} hasPlain=${hasPlain} hasUtf8=${hasUtf8} cmdAt=${cmdAt} trailerAt=${trailerAt} — omit CLEAR_LOCATION_HISTORY_PRELUDE for plain commands in src/platform/shell/powershellProvider.ts`,
  )
}

const locationCommands = [
  'cd -',
  'CD -',
  'chdir -',
  'CHDIR -',
  'sl -',
  'SL -',
  'set-location -',
  'SET-LOCATION -',
  'Set-Location -',
  'push-location .',
  'PUSH-LOCATION .',
  'Push-Location .',
  'pushd .',
  'PUSHD .',
  'pop-location',
  'POP-LOCATION',
  'Pop-Location',
  'popd',
  'POPD',
  'Microsoft.PowerShell.Management\\Set-Location -',
  'c`d -',
  'S`et-Location -',
  'Set\u2013Location -',
  'Write-Output "$(cd -)"',
]

for (const command of locationCommands) {
  const built = await provider.buildExecCommand(command, { id: 'location-check' })
  const clearAt = built.commandString.indexOf(CLEAR_MARKER)
  const cmdAt = built.commandString.indexOf(`\n${command}\n`)
  check(
    `location spelling keeps prelude before command: ${command}`,
    clearAt !== -1 && cmdAt !== -1 && clearAt < cmdAt,
    `clearAt=${clearAt} cmdAt=${cmdAt} — keep CLEAR_LOCATION_HISTORY_PRELUDE before location commands in src/platform/shell/powershellProvider.ts`,
  )
}

const hidingCommands = [
  'invoke-expression $cmd',
  'INVOKE-EXPRESSION $CMD',
  'Invoke-Expression $cmd',
  'iex $cmd',
  'IEX $CMD',
  '& $cmd',
  '& $CMD',
  '& "dir"',
  '& "DIR"',
  "& 'dir'",
  "& 'DIR'",
  '& ("c" + "d")',
  '& ("C" + "D")',
  '& ($cmd)',
  'echo ok; & $cmd',
  '$x = & $cmd',
  '. $script',
  '. $SCRIPT',
  '. "helper"',
  '. "HELPER"',
  ". 'helper'",
  ". 'HELPER'",
  '. .\\script.ps1',
  'echo ok; . $script',
  'pwsh -encodedcommand SQBFAFgA',
  'pwsh -ENCODEDCOMMAND SQBFAFgA',
  'pwsh -EncodedCommand SQBFAFgA',
  'pwsh -enc SQBFAFgA',
  'pwsh -ENC SQBFAFgA',
  'pwsh -ec SQBFAFgA',
  'pwsh -EC SQBFAFgA',
  'invoke-command $sb',
  'INVOKE-COMMAND $SB',
  'icm $sb',
  'ICM $SB',
  '[scriptblock]::Create($s)',
  '$ExecutionContext.InvokeCommand.InvokeScript($s)',
  '.\\run.ps1',
  'echo hi\0',
]

for (const command of hidingCommands) {
  const built = await provider.buildExecCommand(command, { id: 'hiding-check' })
  const clearAt = built.commandString.indexOf(CLEAR_MARKER)
  const cmdAt = built.commandString.indexOf(`\n${command}\n`)
  check(
    `hiding spelling keeps prelude before command: ${JSON.stringify(command)}`,
    clearAt !== -1 && cmdAt !== -1 && clearAt < cmdAt,
    `clearAt=${clearAt} cmdAt=${cmdAt} — keep CLEAR_LOCATION_HISTORY_PRELUDE before hiding or uncertain commands in src/platform/shell/powershellProvider.ts`,
  )
}

console.log(`\npowershell-prelude-when: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
export {}
