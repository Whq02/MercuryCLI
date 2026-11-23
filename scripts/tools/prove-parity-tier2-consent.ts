#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = '', failHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) failures = 1
}

const bash = await import('../../src/tools/shell/prompt.ts')
const bashDescription: string = bash.getSimplePrompt()
t(
  'bash description says output reaches the model, not reliably the operator',
  bashDescription.includes('The output comes back to you; the operator sees at most a folded preview.'),
  '',
  'Restore the sentence The output comes back to you; the operator sees at most a folded preview. in the description returned by getSimplePrompt in src/tools/shell/prompt.ts.',
)
const powershell = await import('../../src/tools/powershell/prompt.ts')
const psDescription: string = await powershell.getPrompt()
t(
  'PowerShell description carries the same sentence, in the same words',
  psDescription.includes('The output comes back to you; the operator sees at most a folded preview.'),
  '',
  'Restore the same sentence, word for word, in the description returned by getPrompt in src/tools/powershell/prompt.ts.',
)

process.exit(failures)
