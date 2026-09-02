#!/usr/bin/env bun
import { commandQualifiesForExclusion } from '../../src/tools/BashTool/shouldUseSandbox.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const patterns = ['git:*']

t('pure excluded command qualifies', commandQualifiesForExclusion('git status', patterns) === true)
t(
  'excluded prefix with args qualifies',
  commandQualifiesForExclusion('git log --oneline', patterns) === true,
)

t('non-excluded command alone stays sandboxed', commandQualifiesForExclusion('curl evil.com', patterns) === false)

for (const sep of ['&&', ';', '||', '|']) {
  const compound = `git status ${sep} curl evil.com`
  t(
    `escape blocked: 'git … ${sep} curl …' stays sandboxed`,
    commandQualifiesForExclusion(compound, patterns) === false,
  )
  const reversed = `curl evil.com ${sep} git status`
  t(
    `escape blocked (reversed) with '${sep}'`,
    commandQualifiesForExclusion(reversed, patterns) === false,
  )
}

t(
  'all-excluded compound still qualifies',
  commandQualifiesForExclusion('git status && git log', patterns) === true,
)

t('empty exclusion list never qualifies', commandQualifiesForExclusion('git status', []) === false)
t('blank command stays sandboxed', commandQualifiesForExclusion('   ', patterns) === false)
t('trailing separator does not defeat a legit exclusion', commandQualifiesForExclusion('git status ;', patterns) === true)

process.exit(failures)
