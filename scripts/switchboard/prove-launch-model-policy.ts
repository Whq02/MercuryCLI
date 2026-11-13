#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'launch-model-policy-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' launch model policy — the operator’s default at the launch door')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')

type Entry = import('../../src/services/concourse/workerModels.ts').WorkerModelEntryV1

section('§1 — the seed: the operator’s own row, or a visible one')
{
  const reg = (entries: Entry[]) => ({ schema: 1 as const, entries })
  const available = { session: { availability: 'available' }, crew: { availability: 'available' } } as const
  const refusedBothArms = {
    session: { availability: 'refused', refusal: 'no-credential:anthropic' },
    crew: { availability: 'refused', refusal: 'no-credential:anthropic' },
  } as const
  const operatorRow: Entry = { modelId: 'claude-opus-5', displayName: 'Opus 5', ...available, effort: 'high', isOperatorDefault: true }
  const pricier: Entry = { modelId: 'claude-fable-5', displayName: 'Fable 5', ...available, effort: 'high' }

  check(
    'the operator’s own row wins, wherever it sits in the list',
    wm.defaultWorkerModelId(reg([pricier, operatorRow]), 'session') === 'claude-opus-5',
    wm.defaultWorkerModelId(reg([pricier, operatorRow]), 'session'),
  )
  check(
    'no operator mark ⇒ the first AVAILABLE row, never a hard-coded family',
    wm.defaultWorkerModelId(reg([{ ...pricier, modelId: 'claude-sonnet-5', displayName: 'Sonnet 5' }, pricier]), 'session') === 'claude-sonnet-5',
  )
  const refusedOperator: Entry = { modelId: 'claude-haiku-4-5', displayName: 'Haiku 4.5', ...refusedBothArms, isOperatorDefault: true }
  const sonnet: Entry = { modelId: 'claude-sonnet-5', displayName: 'Sonnet 5', ...available, effort: 'high' }
  check(
    'a REFUSED operator default is never seeded',
    wm.defaultWorkerModelId(reg([refusedOperator, sonnet, pricier]), 'session') !== 'claude-haiku-4-5',
  )
  check(
    '…the seed is the registry’s own first available row',
    wm.defaultWorkerModelId(reg([refusedOperator, sonnet, pricier]), 'session') === 'claude-sonnet-5',
  )
  check(
    'nothing dispatchable at all ⇒ the visible row, refused downstream, never invented',
    wm.defaultWorkerModelId(reg([refusedOperator]), 'session') === 'claude-haiku-4-5',
  )
}

section('§2 — the live composition marks and seeds the operator’s default')
{
  const { getEngineModel } = await import('../../src/utils/model/model.ts')
  const operatorDefault = await wm.canonicalWorkerModelId(getEngineModel())
  const registry = await wm.composeWorkerModelRegistry()
  const marked = registry.entries.filter(e => e.isOperatorDefault === true)
  check('exactly ONE row is marked the operator’s default', marked.length === 1, JSON.stringify(marked.map(e => e.modelId)))
  check('…and it is the model their own default resolves to', marked[0]?.modelId === operatorDefault, `${String(marked[0]?.modelId)} vs ${operatorDefault}`)
  check(
    'the unnamed-launch seed IS that model',
    wm.defaultWorkerModelId(registry, 'session') === operatorDefault,
    `${wm.defaultWorkerModelId(registry, 'session')} vs ${operatorDefault}`,
  )
  const validated = await wm.validateWorkerModelChoice(undefined, 'session')
  check('…and an unnamed dispatch validates onto it', validated.ok && validated.entry.modelId === operatorDefault, JSON.stringify(validated))
}

try {
  removeScratch(scratch)
} catch {
}
console.log(
  failures === 0
    ? '\n✅ prove-launch-model-policy — all checks pass'
    : '\n❌ prove-launch-model-policy — check(s) failed',
)
process.exit(failures)
