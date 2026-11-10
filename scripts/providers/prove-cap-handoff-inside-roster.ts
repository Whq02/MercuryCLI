#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'cap-handoff-roster-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.DEEPSEEK_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the cap handoff offers only what the roster permits')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const cap = await import('../../src/services/capFailover.ts')
const words = await import('../../src/services/rateLimitMessages.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

const FABLE_52 = 'claude-fable-5-2'
const FABLE_51 = 'claude-fable-5-1'
const DEEPSEEK = 'deepseek-v4-pro'
type Lane = { usable: boolean; blockers: string[]; credential?: 'oauth' | 'api-key' | 'keyless' | 'none' }
const derive = cap.deriveCapFailoverCandidates as (...args: unknown[]) => ReturnType<typeof cap.deriveCapFailoverCandidates>

section('§1 the pure derivation: a target the roster excludes is no candidate, no row, and says why')
{
  const map: Record<string, Lane> = {
    anthropic: { usable: true, blockers: [], credential: 'api-key' },
    deepseek: { usable: true, blockers: [], credential: 'api-key' },
    zai: { usable: true, blockers: [], credential: 'api-key' },
  }
  const at: Record<string, number> = { anthropic: 3000, deepseek: 2000, zai: 1000 }
  const targets: Record<string, string> = { anthropic: FABLE_52, deepseek: DEEPSEEK, zai: 'glm-4.6' }
  const read: string[] = []
  const windowOf = (route: string): null => {
    read.push(route)
    return null
  }
  const set = derive('openai', map, (r: string) => targets[r], (f: string) => at[f], windowOf, (model: string) => model !== FABLE_52)
  check('the excluded target is not a candidate', set.candidates.every(c => c.route !== 'anthropic') && set.candidates.map(c => c.route).join(',') === 'deepseek,zai', JSON.stringify(set.candidates))
  check('it is not a row of the offer either', set.listed.every(row => row.route !== 'anthropic'), JSON.stringify(set.listed.map(row => row.route)))
  check("its lane is excluded in the roster's name: 'the roster excludes claude-fable-5-2'", set.excluded.some(e => e.route === 'anthropic' && e.why === `the roster excludes ${FABLE_52}`), JSON.stringify(set.excluded))
  check('no window is read for a target the roster excludes', !read.includes('anthropic') && read.includes('deepseek'), read.join(','))
  const open = derive('openai', map, (r: string) => targets[r], (f: string) => at[f], () => null, () => true)
  const before = derive('openai', map, (r: string) => targets[r], (f: string) => at[f], () => null)
  check('a roster that permits every target, and no roster at all, give the set the five-argument call gives', JSON.stringify(open) === JSON.stringify(before) && before.candidates.length === 3 && before.excluded.length === 0, JSON.stringify(open))
}

section('§2 the live set under a settings roster')
{
  type Row = { roster: string[] | null; home: string; candidates: string[]; excluded: string[] }
  const rows: Row[] = [
    { roster: null, home: 'openai', candidates: [`anthropic:${FABLE_52}`, `deepseek:${DEEPSEEK}`], excluded: [] },
    { roster: null, home: 'anthropic', candidates: [`deepseek:${DEEPSEEK}`], excluded: [] },
    { roster: [FABLE_51], home: 'openai', candidates: [`anthropic:${FABLE_51}`], excluded: [`deepseek:the roster excludes ${DEEPSEEK}`] },
    { roster: [FABLE_51], home: 'anthropic', candidates: [], excluded: [`deepseek:the roster excludes ${DEEPSEEK}`] },
    { roster: ['claude-opus-5-5'], home: 'openai', candidates: [], excluded: [`anthropic:the roster excludes ${FABLE_52}`, `deepseek:the roster excludes ${DEEPSEEK}`] },
    { roster: [FABLE_51, 'deepseek'], home: 'openai', candidates: [`anthropic:${FABLE_51}`, `deepseek:${DEEPSEEK}`], excluded: [] },
    { roster: ['anthropic'], home: 'openai', candidates: [`anthropic:${FABLE_52}`], excluded: [`deepseek:the roster excludes ${DEEPSEEK}`] },
    { roster: [], home: 'openai', candidates: [], excluded: [`anthropic:the roster excludes ${FABLE_52}`, `deepseek:the roster excludes ${DEEPSEEK}`] },
  ]
  for (const row of rows) {
    writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: row.roster === null ? {} : { roster: row.roster } }))
    resetSettingsCache()
    const set = cap.liveCapFailoverCandidates(row.home)
    const candidates = set.candidates.map(c => `${c.route}:${c.model}`)
    const listed = set.listed.map(l => `${l.route}:${l.model}`)
    const excluded = set.excluded.filter(e => e.route === 'anthropic' || e.route === 'deepseek').map(e => `${e.route}:${e.why}`)
    const target = cap.liveCapFailoverTarget(row.home)
    check(
      `${row.roster === null ? 'no roster' : JSON.stringify(row.roster)} · home ${row.home} → ${row.candidates.length === 0 ? 'no candidate' : row.candidates.join(', ')}`,
      JSON.stringify(candidates) === JSON.stringify(row.candidates) &&
        JSON.stringify(listed) === JSON.stringify(row.candidates) &&
        JSON.stringify(excluded) === JSON.stringify(row.excluded) &&
        (target === null ? row.candidates.length === 0 : `${target.route}:${target.model}` === row.candidates[0]),
      JSON.stringify({ candidates, listed, excluded, target }),
    )
  }
}

section("§3 the refusal row's lane remedy names only a lane the roster permits")
{
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { roster: [FABLE_51] } }))
  resetSettingsCache()
  check('a roster of claude-fable-5-1 alone: no lane is offered from the Anthropic wall', words.crossFamilyLaneRemedy('anthropic') === null, String(words.crossFamilyLaneRemedy('anthropic')))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { roster: [FABLE_51, 'deepseek'] } }))
  resetSettingsCache()
  check('with deepseek on the roster the DeepSeek lane is offered, in the sentence it had', words.crossFamilyLaneRemedy('anthropic') === 'The DeepSeek lane is usable now — /model moves there (bills under your DeepSeek account, not this window).', String(words.crossFamilyLaneRemedy('anthropic')))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: {} }))
  resetSettingsCache()
  check('with no roster the remedy is the sentence it was', words.crossFamilyLaneRemedy('anthropic') === 'The DeepSeek lane is usable now — /model moves there (bills under your DeepSeek account, not this window).', String(words.crossFamilyLaneRemedy('anthropic')))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
