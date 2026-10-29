#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

for (const file of [
  'src/components/MercuryOnboarding.tsx',
  'src/components/MercurySetupFrame.tsx',
  'src/components/MercuryLogin.tsx',
]) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  check(`§A REPRODUCED: ${file} has zero OpenAI routing`, !/openai/i.test(src))
}

check(
  '§B the OpenAI credential owner exists (openaiAccounts.ts)',
  existsSync(join(ROOT, 'src/services/providers/openai/openaiAccounts.ts')),
)

const engines = FLAG_REGISTRY.find(s => s.env === 'MERCURY_ENGINES')
check(
  '§C the ENGINES standing-consent gate exists and is opt-in',
  engines !== undefined && engines.kind === 'opt-in',
  engines ? `kind=${engines.kind}` : 'row missing',
)

console.log(
  failed === 0
    ? '\n REPRODUCED — R02 red recorded (Anthropic-loyal entry window)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
