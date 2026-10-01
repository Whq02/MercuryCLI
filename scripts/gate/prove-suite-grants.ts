#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const ref = process.argv.indexOf('--pool-ref')
const pool = ref >= 0
  ? execFileSync('git', ['show', `${process.argv[ref + 1]}:scripts/run-all-suites.sh`], { cwd: ROOT, encoding: 'utf8' })
  : readFileSync(join(ROOT, 'scripts/run-all-suites.sh'), 'utf8')
const ci = readFileSync(join(ROOT, 'scripts/gate/ci-shard.sh'), 'utf8')
const grants = join(ROOT, 'scripts/gate/suite-ceilings.tsv')
const reader = join(ROOT, 'scripts/gate/suite-grants.sh')
const functions = (source: string, names: string[]): string => names.map(name => {
  const text = source.match(new RegExp(`^${name}\\(\\)[^\\n]*\\n[\\s\\S]*?^}`, 'm'))?.[0]
  assert.ok(text, `${name} must be read from the actual runner`)
  return text
}).join('\n')
const localFunctions = functions(pool, ['dur_row', 'budget_of', 'budget_note'])
function localBudget(suite: string, seconds = '', override = '', file = grants): { budget: number; note: string } {
  const out = execFileSync('bash', ['-c', `. "$1"\nBUDGET_FLOOR=600\nBUDGET_K=2\nBUDGET_OVERRIDE="$4"\nDUR_TABLE="$5"\nCEILING_FILE="$2"\n${localFunctions}\nbudget_of "$3"; printf '\\n'; budget_note "$3"`, '_', reader, file, suite, override, `${suite} ${seconds}`], { encoding: 'utf8', cwd: ROOT })
  const [budget, note = ''] = out.split('\n')
  return { budget: Number(budget), note }
}

assert.equal(localBudget('ui-drives', '700').budget, 4800)
assert.equal(localBudget('transcript-rows-drives', '350').budget, 3000)
assert.equal(localBudget('unlisted', '20').budget, 600)
assert.equal(localBudget('unlisted', '1000').budget, 2000)
assert.equal(localBudget('ui-drives', '3000').budget, 6000)
assert.equal(localBudget('ui-drives', '700', '45').budget, 45)
assert.match(localBudget('ui-drives', '700').note, /4800 s suite grant from scripts\/gate\/suite-ceilings\.tsv/)
assert.ok(pool.includes('. scripts/gate/suite-grants.sh') && ci.includes('. scripts/gate/suite-grants.sh'))
assert.ok(pool.includes('CEILING_FILE=scripts/gate/suite-ceilings.tsv') && ci.includes('CEILING_FILE="${MERCURY_CI_SHARD_CEILING_FILE:-scripts/gate/suite-ceilings.tsv}"'))
console.log('[PASS] local budgets honor the measured suite grants, retain the unlisted default, and preserve the operator override')

const scratch = mkdtempSync(join(tmpdir(), 'suite-grants-'))
try {
  const seed = join(scratch, 'seed.tsv')
  writeFileSync(seed, 'ui-drives\t700\ntranscript-rows-drives\t350\n')
  const ciFunctions = functions(ci, ['seed_row', 'seed_ceiling_of', 'ceiling_of', 'budget_of'])
  for (const suite of ['ui-drives', 'transcript-rows-drives']) {
    const value = execFileSync('bash', ['-c', `. "$1"\nCEILING_FILE="$2"\nSEED_FILE="$3"\nCLASS=drives\nDRIVE_CEILING_K=2\nCEILING_DEFAULT=900\nBUDGET_FLOOR=600\nBUDGET_K=2\nBUDGET_OVERRIDE=\n${ciFunctions}\nbudget_of "$4"`, '_', reader, grants, seed, suite], { encoding: 'utf8', cwd: ROOT })
    assert.equal(Number(value), localBudget(suite).budget)
  }
  const fixtureGrants = join(scratch, 'grants.tsv')
  writeFileSync(fixtureGrants, 'unlisted\t1700\ninvalid\tnope\nzero\t0\n')
  assert.equal(localBudget('unlisted', '20', '', fixtureGrants).budget, 1700)
  assert.equal(localBudget('invalid', '20', '', fixtureGrants).budget, 600)
  assert.equal(localBudget('zero', '20', '', fixtureGrants).budget, 600)
  assert.equal(localBudget('unlisted', '20', '', join(scratch, 'absent')).budget, 600)
  console.log('[PASS] CI and the local pool use the same TSV reader; absent or invalid grants do not raise the default')

  const suites = join(scratch, 'suites')
  for (const name of ['granted', 'unlisted']) {
    mkdirSync(join(suites, name), { recursive: true })
    writeFileSync(join(suites, name, 'run-all.sh'), '#!/usr/bin/env bash\n# gate-class: pure\nexit 0\n')
  }
  writeFileSync(fixtureGrants, 'granted\t1700\n')
  writeFileSync(seed, 'granted\t20\nunlisted\t20\n')
  const verdict = join(scratch, 'verdict.json')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MERCURY_')))
  execFileSync('bash', ['scripts/run-all-suites.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env, BUN: process.env.BUN ?? process.execPath, MERCURY_CONFIG_DIR: join(scratch, 'config'), MERCURY_HOME: join(scratch, 'home'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_GATE_SUITES_DIR: suites, MERCURY_GATE_SEED_FILE: seed, MERCURY_GATE_CEILING_FILE: fixtureGrants, MERCURY_GATE_VERDICT_FILE: verdict, MERCURY_GATE_JOBS: '1' },
  })
  const runs = (JSON.parse(readFileSync(verdict, 'utf8')) as { timeline: { runs: Array<{ suite: string; budgetS: number; rc: number }> } }).timeline.runs
  assert.equal(runs.find(run => run.suite === 'granted')?.budgetS, 1700)
  assert.equal(runs.find(run => run.suite === 'unlisted')?.budgetS, 600)
  assert.ok(runs.length === 2 && runs.every(run => run.rc === 0))
  console.log('[PASS] the real local scheduler records the grant for its named suite and leaves the other suite at the default')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
