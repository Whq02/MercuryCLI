#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const bash = await import('../../src/tools/BashTool/prompt.ts')
const bashDescription: string = bash.getSimplePrompt()
t(
  'bash description says output reaches the model, not reliably the operator',
  bashDescription.includes('the operator does not reliably see it'),
)
const powershell = await import('../../src/tools/PowerShellTool/prompt.ts')
const psDescription: string = await powershell.getPrompt()
t(
  'PowerShell description carries the same clause',
  psDescription.includes('the operator does not reliably see it'),
)

process.exit(failures)
