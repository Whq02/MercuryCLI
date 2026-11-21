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
  bashDescription.includes('The output comes back to you; the operator sees at most a folded preview.'),
)
const powershell = await import('../../src/tools/PowerShellTool/prompt.ts')
const psDescription: string = await powershell.getPrompt()
t(
  'PowerShell description carries the same sentence, in the same words',
  psDescription.includes('The output comes back to you; the operator sees at most a folded preview.'),
)

process.exit(failures)
