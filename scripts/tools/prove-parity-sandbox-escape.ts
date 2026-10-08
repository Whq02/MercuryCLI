#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { commandQualifiesForExclusion as preparedExclusion } from '../../src/tools/BashTool/shouldUseSandbox.ts'
import { parseForSecurity } from '../../src/utils/permissions/decision/commandAnalysis.ts'
const commandQualifiesForExclusion = async (command: string, patterns: readonly string[]): Promise<boolean> => {
  await parseForSecurity(command)
  return preparedExclusion(command, patterns)
}

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const patterns = ['git *']

t('pure excluded command qualifies', (await commandQualifiesForExclusion('git status', patterns)) === true)
t(
  'excluded prefix with args qualifies',
  (await commandQualifiesForExclusion('git log --oneline', patterns)) === true,
)

t('non-excluded command alone stays sandboxed', (await commandQualifiesForExclusion('curl evil.com', patterns)) === false)

for (const sep of ['&&', ';', '||', '|']) {
  const compound = `git status ${sep} curl evil.com`
  t(
    `escape blocked: 'git … ${sep} curl …' stays sandboxed`,
    (await commandQualifiesForExclusion(compound, patterns)) === false,
  )
  const reversed = `curl evil.com ${sep} git status`
  t(
    `escape blocked (reversed) with '${sep}'`,
    (await commandQualifiesForExclusion(reversed, patterns)) === false,
  )
}

t(
  'all-excluded compound still qualifies',
  (await commandQualifiesForExclusion('git status && git log', patterns)) === true,
)

t('empty exclusion list never qualifies', (await commandQualifiesForExclusion('git status', [])) === false)
t('blank command stays sandboxed', (await commandQualifiesForExclusion('   ', patterns)) === false)
t('trailing separator does not defeat a legit exclusion', (await commandQualifiesForExclusion('git status ;', patterns)) === true)

const adapter = readFileSync(new URL('../../src/utils/sandbox/sandbox-adapter.ts', import.meta.url), 'utf8')
const addRoad = adapter.slice(adapter.indexOf('export function addToExcludedCommands'), adapter.indexOf('const existing = SandboxManager.getExcludedCommands()'))
t('the add road keeps the suggested rule as written', /pattern = bashRule\.ruleContent\n/.test(addRoad) && !/\.replace\(/.test(addRoad))

process.exit(failures)
