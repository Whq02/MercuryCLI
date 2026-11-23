#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_BARE

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getOriginalCwd, setOriginalCwd, setCwdState } = await import('../../src/boot/process-state/processState.ts')
const orient = (await import('../../src/commands/orient/orient.ts')).default

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HINT = 'update ORIENT_PROMPT (returned by getPromptForCommand) in src/commands/orient/orient.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orient-projects-own-')))
const prevCwd = process.cwd()
const prevOriginalCwd = getOriginalCwd()

try {
  writeFileSync(join(scratch, 'README.md'), 'sample\n')
  process.chdir(scratch)
  setOriginalCwd(scratch)
  setCwdState(scratch)

  const blocks = await orient.getPromptForCommand()
  const first = blocks[0]
  const text = first && first.type === 'text' ? first.text : ''

  check(
    'getPromptForCommand returns a non-empty text block matching contentLength when no other tools load',
    blocks.length === 1 && text.length > 0 && text.length === orient.contentLength,
    `${HINT}; got ${blocks.length} block(s), length ${text.length}, contentLength ${orient.contentLength}`,
  )

  check(
    'states that MERCURY.md holds only what the repository and its user say (code, scripts, documents, and the user\'s own words)',
    /repository and its user say/i.test(text) && /\bcode\b/i.test(text) && /\bscripts\b/i.test(text) && /\bdocuments\b/i.test(text) && /user's own words/i.test(text),
    `${HINT} to state that the project file holds what the repository and its user say (what the code, its scripts, its documents and the user's own words show); got:\n${text}`,
  )

  check(
    'forbids copying the harness\'s own standing rules (git rules, tool rules, permission rules) that every session already carries',
    /never the harness's own standing rules/i.test(text) && /git rules/i.test(text) && /tool rules/i.test(text) && /permission rules/i.test(text) && /every session already carries/i.test(text),
    `${HINT} to forbid writing the harness's own standing rules (its git rules, its tool rules, its permission rules), which every session already carries; got:\n${text}`,
  )

  check(
    'keeps the existing orient instructions and explicit-import law intact',
    text.startsWith('Study this repository and write MERCURY.md') &&
      text.includes('- Claim nothing you did not verify in files you actually read.') &&
      text.includes('The explicit-import law (this is load-bearing): once MERCURY.md exists, Mercury loads no other'),
    `${HINT} without altering its other words; got:\n${text}`,
  )
} finally {
  process.chdir(prevCwd)
  setOriginalCwd(prevOriginalCwd)
  setCwdState(prevCwd)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} orient writes the project's own: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
