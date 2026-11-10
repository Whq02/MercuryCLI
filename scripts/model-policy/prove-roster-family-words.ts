#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'roster-family-words-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_WORKER_PARENT_PID']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' under a roster a family word and the fallback stay inside it')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const model = await import('../../src/utils/model/model.ts')
const allow = await import('../../src/utils/model/modelAllowlist.ts')
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('anthropic', 'api-key')

const settingsPath = join(scratch, 'settings.json')
type Sent = { sent: string; allowed: boolean }
function under(roster: string[] | null, saved?: string, envModel?: string): Sent {
  writeFileSync(settingsPath, JSON.stringify({ engine: { ...(roster !== null ? { roster } : {}), ...(saved !== undefined ? { model: saved } : {}) } }))
  if (envModel !== undefined) process.env.MERCURY_MODEL = envModel
  else delete process.env.MERCURY_MODEL
  resetSettingsCache()
  resetComputedDefaultMemo()
  const sent = model.getEngineModel()
  return { sent, allowed: allow.isModelAllowed(sent) }
}
const show = (r: Sent): string => JSON.stringify(r)
const is = (r: Sent, id: string): boolean => r.sent === id && r.allowed

section('§1 no roster: every family word is its family head, as before')
{
  const heads: Array<[string, string]> = [['fable', 'claude-fable-5-2'], ['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'], ['fable[1m]', 'claude-fable-5-2[1m]']]
  for (const [word, id] of heads) check(`saved "${word}" → ${id}`, under(null, word).sent === id, show(under(null, word)))
  check('nothing saved on a key sign-in → claude-opus-5-5', under(null).sent === 'claude-opus-5-5', show(under(null)))
}

section('§2 a roster that permits an older generation only: the family word means the newest generation the roster permits')
{
  const cases: Array<[string[], string, string]> = [
    [['claude-fable-5-1'], 'fable', 'claude-fable-5-1'],
    [['claude-fable-5-1'], 'fable[1m]', 'claude-fable-5-1[1m]'],
    [['claude-opus-4-8'], 'opus', 'claude-opus-4-8'],
    [['claude-sonnet-4-6'], 'sonnet', 'claude-sonnet-4-6'],
    [['claude-haiku-4-5'], 'haiku', 'claude-haiku-4-5-20251001'],
    [['fable', 'claude-fable-5-1'], 'fable', 'claude-fable-5-1'],
    [['opus', 'fable51'], 'fable', 'claude-fable-5-1'],
  ]
  for (const [roster, word, id] of cases) {
    const r = under(roster, word)
    check(`${JSON.stringify(roster)} · saved "${word}" → ${id}, inside the roster`, is(r, id), show(r))
  }
  const env = under(['claude-fable-5-1'], undefined, 'fable')
  check('MERCURY_MODEL=fable under ["claude-fable-5-1"] → claude-fable-5-1', is(env, 'claude-fable-5-1'), show(env))
}

section('§3 a roster that permits the head keeps the head, whatever names it')
{
  for (const roster of [['fable'], ['claude-fable-5-2', 'claude-fable-5-1'], ['anthropic'], ['opus', 'fable']]) {
    const r = under(roster, 'fable')
    check(`${JSON.stringify(roster)} · saved "fable" → claude-fable-5-2`, is(r, 'claude-fable-5-2'), show(r))
  }
  const opus = under(['opus', 'fable51'], 'opus')
  check('["opus","fable51"] · saved "opus" → claude-opus-5-5', is(opus, 'claude-opus-5-5'), show(opus))
}

section('§4 nothing saved: the fallback is the best model the roster permits, never an Opus it excludes')
{
  const cases: Array<[string[], string]> = [
    [['claude-sonnet-5-5'], 'claude-sonnet-5-5'],
    [['claude-opus-4-8'], 'claude-opus-4-8'],
    [['sonnet', 'haiku'], 'claude-sonnet-5-5'],
    [['claude-haiku-4-5'], 'claude-haiku-4-5-20251001'],
    [['opus'], 'claude-opus-5-5'],
  ]
  for (const [roster, id] of cases) {
    const r = under(roster)
    check(`${JSON.stringify(roster)} · nothing saved → ${id}, inside the roster`, is(r, id), show(r))
  }
}

section('§5 an operator pin outranks the walk, and an exact id is never rewritten')
{
  process.env.MERCURY_DEFAULT_FABLE_MODEL = 'claude-fable-5-2'
  try {
    const pinned = under(['claude-fable-5-1'], 'fable')
    check('MERCURY_DEFAULT_FABLE_MODEL names the family word verbatim under a roster', pinned.sent === 'claude-fable-5-2', show(pinned))
  } finally {
    delete process.env.MERCURY_DEFAULT_FABLE_MODEL
  }
  const exact = under(['claude-fable-5-1'], 'claude-fable-5-2')
  check('a saved exact id resolves to itself (the roster refuses it at the door, it is never swapped for another model)', exact.sent === 'claude-fable-5-2' && !exact.allowed, show(exact))
  const generation = under(['claude-fable-5-2'], 'fable51')
  check('an exact-generation alias resolves to its generation', generation.sent === 'claude-fable-5-1' && !generation.allowed, show(generation))
}

under(null)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
