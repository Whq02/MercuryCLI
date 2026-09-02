#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-spoken-model-launch.ts — the spoken-name
//  resolution at THE ONE callable-model validator (the seam every launch
//  door rides: coordinator launch_session → concourseDispatch →
//  validateWorkerModelChoice). "sonnet 5" lands on the one canonical row;
//  a genuine unknown refuses with the ruled sentence. (The driven half —
//  the coordinator tool against the DIST daemon — lives in the lane
//  record; this pin keeps the resolver from regressing.)
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'spoken-model-'))
delete process.env.MERCURY_HOME
// Source-prover posture: config reads open before the boot gate arms.
process.env.NODE_ENV = 'test'
// A synthetic credential so the anthropic rows classify available —
// presence only; nothing dials out (no call leaves this prover).
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
  // The route-honesty re-class: 'sonnnet 9' carries no family mark at all,
  // so it refuses with the honest family-less class — the ruled
  // unknown-model sentence stays pinned on a HOME-shaped stranger below.
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
