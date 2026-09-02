#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'spoken-model-'))
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'sk-ant-spoken-model-pin'

const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')

let failures = 0
const check = (n: string, c: boolean, detail = ''): void => {
  if (!c) failures++
  console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${detail ? ` — ${detail}` : ''}`)
}

{
  const v = await validateWorkerModelChoice('sonnet 5', 'session')
  check('"sonnet 5" resolves to the one canonical row', v.ok === true && v.entry.modelId === 'claude-sonnet-5', JSON.stringify(v).slice(0, 120))
}
{
  const v = await validateWorkerModelChoice('Opus-5', 'session')
  check('"Opus-5" resolves the same seam', v.ok === true && v.entry.modelId === 'claude-opus-5')
}
{
  const v = await validateWorkerModelChoice('claude-sonnet-5', 'session')
  check('the exact id stays a passthrough', v.ok === true && v.entry.modelId === 'claude-sonnet-5')
}
{
  const v = await validateWorkerModelChoice('sonnnet 9', 'session')
  check(
    'a family-less unknown refuses not-runnable:unrecognised',
    v.ok === false && v.reason === 'not-runnable:unrecognised' && String(v.detail ?? '').includes('no provider family declares'),
  )
}
{
  const v = await validateWorkerModelChoice('claude-sonnnet-9', 'session')
  check(
    'a home-shaped stranger keeps the ruled unknown-model sentence',
    v.ok === false && v.reason === 'unknown-model' && String(v.detail ?? '').includes('is not an exact model id'),
  )
}

if (failures > 0) {
  console.log(`\nprove-spoken-model-launch: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-spoken-model-launch: ALL LAWS HOLD')
