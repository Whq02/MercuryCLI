#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'roster-one-generation-'))
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' a roster entry that names one generation admits that one')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const allow = await import('../../src/utils/model/modelAllowlist.ts')
const model = await import('../../src/utils/model/model.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const { DECLARED_GENERATION_STEMS, parseFirstPartyGeneration } = await import('../../src/utils/model/configs.ts')
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('anthropic', 'api-key')

const settingsPath = join(scratch, 'settings.json')
function roster(entries: string[] | null): void {
  writeFileSync(settingsPath, JSON.stringify({ engine: entries === null ? {} : { roster: entries } }))
  resetSettingsCache()
  resetComputedDefaultMemo()
}
function admits(entry: string, candidate: string): boolean {
  roster([entry])
  return allow.isModelAllowed(candidate)
}
const generationOf = (id: string): string | undefined => {
  const stem = parseFirstPartyGeneration(id)?.stem
  return stem !== undefined && DECLARED_GENERATION_STEMS.has(stem) ? stem : undefined
}
const prefixRule = (entry: string, candidate: string): boolean => candidate === entry || candidate.startsWith(`${entry}-`)
const rank = (stem: string): number[] => stem.replace(/^claude-[a-z]+-/, '').split('-').map(Number)
const older = (a: string, b: string): boolean => {
  const [x, y] = [rank(a), rank(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

const declared = [...DECLARED_GENERATION_STEMS.keys()].sort()

section('§1 every declared id as the one roster entry × every declared id as the candidate')
{
  const kept: string[] = []
  const flipped: string[] = []
  const wrong: string[] = []
  for (const entry of declared) {
    for (const candidate of declared) {
      const before = prefixRule(entry, candidate)
      const [named, asked] = [generationOf(entry), generationOf(candidate)]
      const anotherGeneration = named !== undefined && asked !== undefined && named !== asked
      const expected = before && !anotherGeneration
      const now = admits(entry, candidate)
      if (before && anotherGeneration) flipped.push(`${entry} → ${candidate}`)
      else if (before) kept.push(`${entry} → ${candidate}`)
      if (now !== expected) wrong.push(`${entry} → ${candidate}: ${now}, expected ${expected}`)
    }
  }
  console.log(`  ${declared.length} declared ids, ${declared.length * declared.length} cells; the prefix rule admitted ${kept.length + flipped.length}; ${flipped.length} name another declared generation:`)
  for (const cell of flipped) console.log(`    ${cell}`)
  check('the matrix has the 33 declared ids and canonical stems', declared.length === 33, String(declared.length))
  check('every cell reads the prefix rule, less the cells whose candidate is another declared generation of the entry\'s family', wrong.length === 0, wrong.join(' | '))
  check('sixteen cells flip, and no other', flipped.length === 16, String(flipped.length))
  check('each of them is an older-generation entry and a newer-generation candidate', flipped.every(cell => {
    const [entry, candidate] = cell.split(' → ') as [string, string]
    return older(generationOf(entry)!, generationOf(candidate)!)
  }))
  check('claude-fable-5 no longer admits Fable 5.1 or 5.2; claude-opus-5 no longer admits Opus 5.5', ['claude-fable-5 → claude-fable-5-1', 'claude-fable-5 → claude-fable-5-2', 'claude-opus-5 → claude-opus-5-5'].every(cell => flipped.includes(cell)) && !admits('claude-fable-5', 'claude-fable-5-1') && !admits('claude-fable-5', 'claude-fable-5-2') && !admits('claude-opus-5', 'claude-opus-5-5'))
  check('every declared id still admits itself, and a canonical stem its dated id', declared.every(id => admits(id, id)) && admits('claude-haiku-4-5', 'claude-haiku-4-5-20251001') && admits('claude-opus-4', 'claude-opus-4-20250514') && admits('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929') && admits('claude-3-5-haiku', 'claude-3-5-haiku-20241022'))
}

section('§2 everything else the prefix rule admitted stays admitted')
{
  const stays: Array<[string, string, string]> = [
    ['claude-fable-5-1', 'claude-fable-5-1-20261001', 'a dated snapshot of the generation named'],
    ['claude-fable-5', 'claude-fable-5-20260301', 'a dated snapshot of Fable 5 itself'],
    ['claude-fable-5-1', 'claude-fable-5-1-fast', 'a suffix sibling of the generation named'],
    ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'the window rider'],
    ['gpt-5', 'gpt-5-mini', "another vendor's id"],
    ['deepseek-v4', 'deepseek-v4-pro', "another vendor's id"],
    ['claude-fable', 'claude-fable-5-2', 'a prefix shorter than a generation'],
    ['claude-opus', 'claude-opus-5-5', 'a prefix shorter than a generation'],
    ['fable', 'claude-fable-5', 'the family word'],
    ['fable', 'claude-fable-5-1', 'the family word'],
    ['fable', 'claude-fable-5-2', 'the family word'],
    ['opus', 'claude-opus-5-5', 'the family word'],
    ['anthropic', 'claude-opus-5-5', "the provider's word"],
    ['fable51', 'claude-fable-5-1', 'a generation alias'],
  ]
  for (const [entry, candidate, why] of stays) check(`["${entry}"] admits ${candidate} (${why})`, admits(entry, candidate))
  check('["fable51"] still does not admit claude-fable-5-2', !admits('fable51', 'claude-fable-5-2'))
}

section('§3 the same entry spelled without the vendor mark, and what a roster of one generation now defaults to')
{
  check('["fable-5"] admits claude-fable-5 and no longer claude-fable-5-2', admits('fable-5', 'claude-fable-5') && !admits('fable-5', 'claude-fable-5-2'), `${admits('fable-5', 'claude-fable-5')} ${admits('fable-5', 'claude-fable-5-2')}`)
  roster(['claude-fable-5'])
  const sent = model.normalizeModelStringForAPI(model.getEngineModel())
  check('a roster of claude-fable-5 alone, nothing saved: the default is Fable 5, inside the roster', sent === 'claude-fable-5' && allow.isModelAllowed(sent), sent)
  const fableSetting = String(model.getEngineModel())
  const fableBetas = caps.getAllModelBetas(fableSetting)
  check('…as the id stands — no [1m] rider, no 1M beta header on its request, its own 1,000,000 window', fableSetting === 'claude-fable-5' && !fableBetas.includes('context-1m-2025-08-07') && caps.getContextWindowForModel(fableSetting) === 1_000_000, `${fableSetting} ${JSON.stringify(fableBetas)} ${caps.getContextWindowForModel(fableSetting)}`)
  roster(['claude-opus-5'])
  const opus = model.normalizeModelStringForAPI(model.getEngineModel())
  check('a roster of claude-opus-5 alone, nothing saved: the default is Opus 5, inside the roster', opus === 'claude-opus-5' && allow.isModelAllowed(opus), opus)
  roster(['claude-fable-5', 'claude-fable-5-2'])
  const both = model.normalizeModelStringForAPI(model.getEngineModel())
  check('a roster that names Fable 5 and Fable 5.2 defaults to the newer and excludes Fable 5.1', both === 'claude-fable-5-2' && !allow.isModelAllowed('claude-fable-5-1'), both)
}

section('§4 a roster that names a retired generation names that generation: the later ones are refused at the door, the named id is not')
{
  for (const [entry, dated, later] of [['claude-opus-4', 'claude-opus-4-20250514', ['claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']], ['claude-sonnet-4', 'claude-sonnet-4-20250514', ['claude-sonnet-4-5', 'claude-sonnet-4-6']]] as Array<[string, string, string[]]>) {
    roster([entry])
    check(`["${entry}"] admits ${dated} and none of ${later.join(', ')}`, allow.isModelAllowed(entry) && allow.isModelAllowed(dated) && later.every(id => !allow.isModelAllowed(id)), later.filter(id => allow.isModelAllowed(id)).join(' '))
    const refusals = later.map(id => allow.rosterRefusal(id))
    check(`…each later id is refused before any request with the roster's sentence, and ${dated} is not refused at the door`, refusals.every(words => words !== null && words.includes("is outside this organization's engine.roster")) && allow.rosterRefusal(dated) === null, JSON.stringify(refusals).slice(0, 300))
  }
}

section('§5 a generation this build does not declare is another generation: an entry that names one refuses it, and an entry that names it admits it alone')
{
  const refused: Array<[string, string, string]> = [
    ['claude-fable-5', 'claude-fable-5-3', 'a later generation nothing declares'],
    ['claude-fable-5', 'claude-fable-5-3-20270101', 'a dated snapshot of that later generation'],
    ['claude-fable-5-2', 'claude-fable-5-3', 'the generation after the newest declared'],
    ['claude-opus-4', 'claude-opus-4-9', 'a later generation nothing declares'],
    ['fable-5', 'claude-fable-5-3', 'the entry spelled without the vendor mark'],
    ['claude-mythos-5', 'claude-mythos-5-7', 'a later mirror nothing declares'],
    ['claude-fable-5-3', 'claude-fable-5-4', 'an undeclared entry against the generation after it'],
    ['claude-fable-5-3', 'claude-fable-5-3-1', 'an undeclared entry against a generation under it'],
    ['claude-fable-5-3', 'claude-fable-5-2', 'an undeclared entry against a declared generation'],
  ]
  for (const [entry, candidate, why] of refused) {
    check(`["${entry}"] refuses ${candidate} (${why})`, !admits(entry, candidate) && (allow.rosterRefusal(candidate) ?? '').includes("is outside this organization's engine.roster"))
  }
  const admitted: Array<[string, string, string]> = [
    ['claude-fable-5-3', 'claude-fable-5-3', 'the undeclared generation it names'],
    ['claude-fable-5-3', 'claude-fable-5-3-20270101', 'a dated snapshot of the generation it names'],
    ['claude-fable-5-3', 'claude-fable-5-3[1m]', 'the window rider'],
    ['fable', 'claude-fable-5-3', 'the family word, which covers every generation'],
    ['claude-fable', 'claude-fable-5-3', 'a prefix shorter than a generation'],
  ]
  for (const [entry, candidate, why] of admitted) check(`["${entry}"] admits ${candidate} (${why})`, admits(entry, candidate))
}

section('§6 the word mythos in a roster covers every Mythos id, as fable covers the Fable ones')
{
  const mythosIds = ['claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2', 'claude-mythos-5-2[1m]', 'claude-mythos-5-7', 'mythos']
  check(`["mythos"] admits ${mythosIds.join(', ')}`, mythosIds.every(id => admits('mythos', id)), mythosIds.filter(id => !admits('mythos', id)).join(' '))
  roster(['mythos'])
  check('…and a session saved on claude-mythos-5 or claude-mythos-5-1 is not refused at its next boot', allow.rosterRefusal('claude-mythos-5') === null && allow.rosterRefusal('claude-mythos-5-1') === null)
  const fableIds = ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'fable']
  check('["mythos"] admits no Fable id and no other family', fableIds.every(id => !admits('mythos', id)) && !admits('mythos', 'claude-opus-5-5'), fableIds.filter(id => admits('mythos', id)).join(' '))
  check('["fable"] admits no Mythos id', ['claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2', 'mythos'].every(id => !admits('fable', id)))
  roster(['mythos', 'claude-mythos-5-1'])
  const narrowedMythos = ['claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2'].map(id => allow.isModelAllowed(id))
  roster(['fable', 'claude-fable-5-1'])
  const narrowedFable = ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2'].map(id => allow.isModelAllowed(id))
  check('beside a more specific Mythos entry the word names that entry alone, as fable does beside a more specific Fable entry', narrowedMythos.join(',') === 'false,true,false' && narrowedFable.join(',') === 'false,true,false', `${narrowedMythos.join(',')} · ${narrowedFable.join(',')}`)
  check('["claude-mythos-5-2"] still admits the word mythos, which names that id', admits('claude-mythos-5-2', 'mythos') && !admits('claude-mythos-5-1', 'mythos'))
  roster(['fable', 'mythos'])
  check('["fable", "mythos"] admits both families whole', ['claude-fable-5', 'claude-fable-5-2', 'claude-mythos-5', 'claude-mythos-5-2'].every(id => allow.isModelAllowed(id)) && !allow.isModelAllowed('claude-opus-5-5'))
}

roster(null)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
