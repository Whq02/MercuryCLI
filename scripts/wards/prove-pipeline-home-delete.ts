import { evaluateWards, REFUSAL_WARDS, setHomeSpellings } from '../../src/utils/wards/wards.ts'
let failed = 0
const check = (command: string, refused: boolean): void => {
  const verdict = evaluateWards(REFUSAL_WARDS, { toolName: 'PowerShell', input: { command }, shellCommand: command })
  const ok = verdict.allow !== refused && (verdict.allow || verdict.rule.name === 'no-root-recursive-delete')
  console.log(`${ok ? 'PASS' : 'FAIL'} ${refused ? 'refuses' : 'allows'} ${command}`)
  if (!ok) failed++
}
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
for (const platform of ['darwin', 'win32']) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  setHomeSpellings(() => ['/Users/sam', '/srv/sam-home'])
  for (const command of [
    'Get-ChildItem $env:USERPROFILE -Recurse | Remove-Item -Recurse -Force',
    'gci $HOME -r | ri -r -fo',
    'gci $HOME -r | ri -r -fo -WhatIf:$false',
    'gci ~ -r | ri -r -fo',
    'Get-ChildItem -LiteralPath /Users/sam -Recurse | Remove-Item -Recurse -Force',
    'gci /srv/sam-home -r | ri -r -fo',
    'gci $env:USERPROFILE -r | Where-Object { $_.Name } | ri -r -fo',
  ]) check(command, true)
  for (const command of [
    'gci /Users/sam/project -r | ri -r -fo',
    'gci .\\dist -r | ri -r -fo',
    'gci $env:TEMP -r | ri -r -fo',
    'gci $env:USERPROFILE -r | Measure-Object',
    'gci $env:USERPROFILE -r; ri .\\dist -r -fo',
    'gci $env:USERPROFILE -r | ri -WhatIf -r -fo',
  ]) check(command, false)
}
Object.defineProperty(process, 'platform', descriptor)
setHomeSpellings(undefined)
console.log(`${failed === 0 ? 'PASS' : 'FAIL'} pipeline home delete`)
process.exit(failed ? 1 : 0)
